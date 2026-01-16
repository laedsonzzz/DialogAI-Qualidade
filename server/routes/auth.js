import express from 'express';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { writeAudit } from '../middleware/audit.js';

/**
 * Util: obter segredo JWT da env
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  return new TextEncoder().encode(secret);
}

/**
 * Util: cria access token curto (15m)
 */
async function createAccessToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sub: user.id,
    email: user.email,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 15) // 15 minutos
    .sign(getJwtSecret());
}

/**
 * Util: cria refresh token (7 dias)
 */
async function createRefreshToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sub: user.id,
    email: user.email,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60 * 24 * 7) // 7 dias
    .sign(getJwtSecret());
}

/**
 * Util: extrai IP/UA para auditoria
 */
function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
}
function getUA(req) {
  return (req.headers['user-agent'] || '').toString();
}

/**
 * Cria router de autenticação
 * Endpoints:
 *  - POST /login
 *  - POST /logout
 *  - POST /refresh
 *  - GET /me
 */
export function authRoutes(pgClient) {
  const router = express.Router();

  /**
   * POST /api/auth/login
   * Fluxos:
   *  - Primeiro acesso: password_hash NULL ou must_reset_password=true
   *    - Se não informar new_password: retorna { require_set_password: true }
   *    - Se informar new_password+confirm_password (válidos): salva hash e autentica
   *  - Acesso normal: valida senha, emite JWT
   */
  router.post('/login', async (req, res) => {
    const { email, password, new_password, confirm_password } = req.body || {};
    const ip = getIp(req);
    const ua = getUA(req);

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email é obrigatório' });
    }

    try {
      const u = await pgClient.query(
        `SELECT id, email, full_name, password_hash, must_reset_password, status
         FROM public.users
         WHERE email ILIKE $1
         LIMIT 1`,
        [email]
      );

      if (u.rows.length === 0) {
        // registra histórico de falha
        await pgClient.query(
          `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
           VALUES (NULL, NULL, FALSE, $1, $2, $3)`,
          ['user_not_found', ip, ua]
        );
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }

      const user = u.rows[0];
      if (user.status !== 'active') {
        await pgClient.query(
          `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
           VALUES ($1, NULL, FALSE, $2, $3, $4)`,
          [user.id, 'user_inactive', ip, ua]
        );
        return res.status(403).json({ error: 'Usuário inativo' });
      }

      const passwordMin = parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10);

      // Primeiro acesso (sem hash) ou exigindo reset
      if (!user.password_hash || user.must_reset_password) {
        if (!new_password || !confirm_password) {
          return res.status(200).json({ require_set_password: true });
        }
        if (new_password !== confirm_password) {
          return res.status(400).json({ error: 'Senhas não coincidem' });
        }
        if (String(new_password).length < passwordMin) {
          return res
            .status(400)
            .json({ error: `Senha deve ter pelo menos ${passwordMin} caracteres` });
        }

        const hash = await argon2.hash(String(new_password), { type: argon2.argon2id });
        // Salva hash e libera acesso
        await pgClient.query(
          `UPDATE public.users
             SET password_hash = $1, must_reset_password = FALSE, updated_at = now()
           WHERE id = $2`,
          [hash, user.id]
        );

        const access_token = await createAccessToken(user);
        const refresh_token = await createRefreshToken(user);
        await pgClient.query(
          `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
           VALUES ($1, NULL, TRUE, $2, $3, $4)`,
          [user.id, 'first_login_password_set', ip, ua]
        );
        // Auditoria
        try {
          req.user = { id: user.id };
          await writeAudit(pgClient, req, {
            entityType: 'auth',
            entityId: String(user.id),
            action: 'first_login_password_set',
            before: null,
            after: { success: true },
          });
        } catch {}

        return res.json({
          access_token,
          refresh_token,
          user: { id: user.id, email: user.email, full_name: user.full_name },
          require_set_password: false,
        });
      }

      // Acesso normal: validar senha
      if (!password) {
        return res.status(400).json({ error: 'Senha é obrigatória' });
      }
      const valid = await argon2.verify(String(user.password_hash), String(password));
      if (!valid) {
        await pgClient.query(
          `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
           VALUES ($1, NULL, FALSE, $2, $3, $4)`,
          [user.id, 'invalid_password', ip, ua]
        );
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }

      const access_token = await createAccessToken(user);
      const refresh_token = await createRefreshToken(user);
      await pgClient.query(
        `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
         VALUES ($1, NULL, TRUE, $2, $3, $4)`,
        [user.id, 'login', ip, ua]
      );
      // Auditoria
      try {
        req.user = { id: user.id };
        await writeAudit(pgClient, req, {
          entityType: 'auth',
          entityId: String(user.id),
          action: 'login',
          before: null,
          after: { success: true },
        });
      } catch {}

      return res.json({
        access_token,
        refresh_token,
        user: { id: user.id, email: user.email, full_name: user.full_name },
        require_set_password: false,
      });
    } catch (err) {
      console.error('Auth login error:', err);
      return res.status(500).json({ error: 'Erro ao autenticar' });
    }
  });

  /**
   * POST /api/auth/logout
   * Apenas registra histórico de logout.
   */
  router.post('/logout', async (req, res) => {
    try {
      // Tenta extrair user do token para log
      let userId = null;
      const authz = req.headers.authorization || '';
      if (authz.startsWith('Bearer ')) {
        const token = authz.slice('Bearer '.length);
        try {
          const { payload } = await jwtVerify(token, getJwtSecret());
          userId = payload.sub || null;
        } catch {
          // token inválido ou expirado; segue mesmo assim
        }
      }
      await pgClient.query(
        `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
         VALUES ($1, NULL, TRUE, $2, $3, $4)`,
        [userId, 'logout', getIp(req), getUA(req)]
      );
      // Auditoria
      try {
        if (userId) req.user = { id: userId };
        await writeAudit(pgClient, req, {
          entityType: 'auth',
          entityId: String(userId || 'unknown'),
          action: 'logout',
          before: null,
          after: { success: true },
        });
      } catch {}
      return res.json({ ok: true });
    } catch (err) {
      console.error('Auth logout error:', err);
      return res.status(500).json({ error: 'Erro ao realizar logout' });
    }
  });

  /**
   * POST /api/auth/refresh
   * Recebe refresh_token e emite novo access_token (e refresh_token rotacionado)
   */
  router.post('/refresh', async (req, res) => {
    try {
      const { refresh_token } = req.body || {};
      if (!refresh_token) {
        return res.status(400).json({ error: 'refresh_token é obrigatório' });
      }
      let payload;
      try {
        const result = await jwtVerify(refresh_token, getJwtSecret());
        payload = result.payload;
      } catch {
        return res.status(401).json({ error: 'refresh_token inválido ou expirado' });
      }
      if (payload?.type !== 'refresh') {
        return res.status(400).json({ error: 'Token enviado não é um refresh_token' });
      }
      const userId = payload.sub;
      const u = await pgClient.query(
        `SELECT id, email, full_name, status
           FROM public.users
          WHERE id = $1
          LIMIT 1`,
        [userId]
      );
      if (u.rows.length === 0 || u.rows[0].status !== 'active') {
        return res.status(401).json({ error: 'Usuário inválido' });
      }
      const user = u.rows[0];
      const access_token = await createAccessToken(user);
      const new_refresh_token = await createRefreshToken(user);
      return res.json({ access_token, refresh_token: new_refresh_token });
    } catch (err) {
      console.error('Auth refresh error:', err);
      return res.status(500).json({ error: 'Erro ao renovar token' });
    }
  });

  /**
   * GET /api/auth/me
   * Retorna perfil e a lista de clientes com permissões do usuário.
   * Requer Authorization: Bearer <token>
   */
  router.get('/me', async (req, res) => {
    const authz = req.headers.authorization || '';
    if (!authz.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const token = authz.slice('Bearer '.length);
    try {
      const { payload } = await jwtVerify(token, getJwtSecret());
      const userId = payload.sub;

      const u = await pgClient.query(
        `SELECT id, email, full_name, status, is_admin
         FROM public.users
         WHERE id = $1`,
        [userId]
      );
      if (u.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      // Avatar status for cache-busting on frontend
      const a = await pgClient.query(
        `SELECT updated_at
           FROM public.user_avatars
          WHERE user_id = $1
          LIMIT 1`,
        [userId]
      );
      const avatar_present = a.rows.length > 0;
      const avatar_updated_at = avatar_present ? a.rows[0].updated_at : null;

      const perms = await pgClient.query(
        `SELECT uc.client_id, c.name AS client_name, c.code AS client_code,
                uc.tipo_usuario, uc.can_start_chat, uc.can_edit_kb, uc.can_view_team_chats, uc.can_view_all_client_chats, uc.can_manage_scenarios
           FROM public.user_clients uc
           JOIN public.clients c ON c.id = uc.client_id
          WHERE uc.user_id = $1
          ORDER BY c.name`,
        [userId]
      );

      return res.json({
        user: { ...u.rows[0], avatar_present, avatar_updated_at },
        clients: perms.rows.map((r) => ({
          client_id: r.client_id,
          client_name: r.client_name,
          client_code: r.client_code,
          tipo_usuario: r.tipo_usuario,
          permissions: {
            can_start_chat: r.can_start_chat,
            can_edit_kb: r.can_edit_kb,
            can_view_team_chats: r.can_view_team_chats,
            can_view_all_client_chats: r.can_view_all_client_chats,
            can_manage_scenarios: r.can_manage_scenarios,
          },
        })),
      });
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  });

  /**
   * GET /api/auth/bootstrap
   * Indica se é necessário fluxo de bootstrap (nenhum usuário cadastrado).
   * Público (sem auth).
   */
  router.get('/bootstrap', async (_req, res) => {
    try {
      const r = await pgClient.query(`SELECT COUNT(*)::int AS cnt FROM public.users`);
      const cnt = r.rows[0]?.cnt ?? 0;
      return res.json({ needs_bootstrap: cnt === 0 });
    } catch (err) {
      console.error('Auth bootstrap status error:', err);
      return res.status(500).json({ error: 'Erro ao verificar bootstrap' });
    }
  });

  /**
   * POST /api/auth/bootstrap
   * Cria o primeiro usuário (administrador inicial) quando a tabela de usuários está vazia.
   * Público (sem auth), porém bloqueado se já existe qualquer usuário.
   * Retorna access_token e refresh_token para entrar diretamente.
   */
  router.post('/bootstrap', async (req, res) => {
    const ip = getIp(req);
    const ua = getUA(req);
    try {
      const r = await pgClient.query(`SELECT COUNT(*)::int AS cnt FROM public.users`);
      const cnt = r.rows[0]?.cnt ?? 0;
      if (cnt > 0) {
        return res.status(409).json({ error: 'Bootstrap não permitido: já existem usuários' });
      }

      const { email, full_name, password } = req.body || {};
      if (!email || !full_name || !password) {
        return res.status(400).json({ error: 'email, full_name e password são obrigatórios' });
      }

      const passwordMin = parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10);
      if (String(password).length < passwordMin) {
        return res
          .status(400)
          .json({ error: `Senha deve ter pelo menos ${passwordMin} caracteres` });
      }

      const hash = await argon2.hash(String(password), { type: argon2.argon2id });
      const ins = await pgClient.query(
        `INSERT INTO public.users (email, full_name, password_hash, must_reset_password, status, is_admin, created_at, updated_at)
         VALUES ($1, $2, $3, FALSE, 'active', TRUE, now(), now())
         RETURNING id, email, full_name, is_admin`,
        [email, full_name, hash]
      );
      const user = ins.rows[0];

      const access_token = await createAccessToken(user);
      const refresh_token = await createRefreshToken(user);

      await pgClient.query(
        `INSERT INTO public.login_history (user_id, client_id, success, reason, ip, user_agent)
         VALUES ($1, NULL, TRUE, $2, $3, $4)`,
        [user.id, 'bootstrap_admin_created', ip, ua]
      );

      // Auditoria
      try {
        req.user = { id: user.id };
        await writeAudit(pgClient, req, {
          entityType: 'auth',
          entityId: String(user.id),
          action: 'bootstrap_admin_created',
          before: null,
          after: { email, full_name },
        });
      } catch {}

      return res.json({
        access_token,
        refresh_token,
        user,
        require_set_password: false,
      });
    } catch (err) {
      console.error('Auth bootstrap create error:', err);
      return res.status(500).json({ error: 'Erro ao criar administrador inicial' });
    }
  });

  /**
   * GET /api/auth/admin_status
   * Indica se existe pelo menos um administrador ativo.
   * Público (sem auth).
   */
  router.get('/admin_status', async (_req, res) => {
    try {
      const r = await pgClient.query(`SELECT COUNT(*)::int AS cnt FROM public.users WHERE is_admin = TRUE AND status = 'active'`);
      const cnt = r.rows[0]?.cnt ?? 0;
      return res.json({ has_admin: cnt > 0 });
    } catch (err) {
      console.error('Auth admin_status error:', err);
      return res.status(500).json({ error: 'Erro ao verificar status de administrador' });
    }
  });

  /**
   * POST /api/auth/elevate_if_no_admin
   * Eleva o usuário autenticado a administrador caso não exista nenhum admin ativo.
   * Requer Authorization: Bearer <token>
   */
  router.post('/elevate_if_no_admin', async (req, res) => {
    try {
      const authz = req.headers.authorization || '';
      if (!authz.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Não autenticado' });
      }
      const token = authz.slice('Bearer '.length);
      let userId;
      try {
        const { payload } = await jwtVerify(token, getJwtSecret());
        userId = payload.sub;
      } catch {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
      }

      const r = await pgClient.query(`SELECT COUNT(*)::int AS cnt FROM public.users WHERE is_admin = TRUE AND status = 'active'`);
      const cnt = r.rows[0]?.cnt ?? 0;
      if (cnt > 0) {
        return res.status(409).json({ error: 'Já existe administrador', code: 'ADMIN_EXISTS' });
      }

      const upd = await pgClient.query(
        `UPDATE public.users
            SET is_admin = TRUE, updated_at = now()
          WHERE id = $1
        RETURNING id, email, full_name, is_admin`,
        [userId]
      );
      if (upd.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      // Auditoria
      try {
        req.user = { id: userId };
        await writeAudit(pgClient, req, {
          entityType: 'auth',
          entityId: String(userId),
          action: 'elevate_if_no_admin',
          before: null,
          after: { is_admin: true },
        });
      } catch {}

      return res.json({ ok: true, elevated: true, user: upd.rows[0] });
    } catch (err) {
      console.error('Auth elevate_if_no_admin error:', err);
      return res.status(500).json({ error: 'Erro ao elevar administrador' });
    }
  });

  return router;
}