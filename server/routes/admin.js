import express from 'express';
import { writeAudit } from '../middleware/audit.js';

/**
 * Check if the current authenticated user is admin.
 * requireAuth(pgClient) must be applied before this router (to set req.user).
 */
async function ensureAdmin(pgClient, req, res) {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Não autenticado' });
      return null;
    }
    const r = await pgClient.query(
      `SELECT id, is_admin, email, full_name, status
         FROM public.users
        WHERE id = $1
        LIMIT 1`,
      [req.user.id]
    );
    if (r.rows.length === 0) {
      res.status(401).json({ error: 'Usuário não encontrado' });
      return null;
    }
    const u = r.rows[0];
    if (u.status !== 'active') {
      res.status(403).json({ error: 'Usuário inativo' });
      return null;
    }
    if (u.is_admin !== true) {
      res.status(403).json({ error: 'Acesso negado: requer administrador' });
      return null;
    }
    return u;
  } catch (err) {
    console.error('ensureAdmin error:', err);
    res.status(500).json({ error: 'Erro ao validar administrador' });
    return null;
  }
}

export function adminRoutes(pgClient) {
  const router = express.Router();

  // Clients CRUD
  router.post('/clients', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { name, code } = req.body || {};
      if (!name || !code) {
        return res.status(400).json({ error: 'name e code são obrigatórios' });
      }

      const ins = await pgClient.query(
        `INSERT INTO public.clients (name, code, created_at, updated_at)
         VALUES ($1, $2, now(), now())
         RETURNING id, name, code`,
        [name, code]
      );

      const client = ins.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'clients',
        entityId: client.id,
        action: 'create',
        before: null,
        after: client,
      });

      return res.json(client);
    } catch (err) {
      console.error('Admin create client error:', err);
      return res.status(500).json({ error: 'Erro ao criar cliente' });
    }
  });

  router.get('/clients', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const r = await pgClient.query(
        `SELECT id, name, code, created_at, updated_at
           FROM public.clients
          ORDER BY name ASC`
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Admin list clients error:', err);
      return res.status(500).json({ error: 'Erro ao listar clientes' });
    }
  });

  router.patch('/clients/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;
      const { name, code } = req.body || {};

      const prev = await pgClient.query(
        `SELECT id, name, code FROM public.clients WHERE id = $1`,
        [id]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }
      const before = prev.rows[0];

      const values = [];
      const sets = [];
      let idx = 1;
      if (typeof name === 'string') {
        sets.push(`name = $${idx++}`);
        values.push(name);
      }
      if (typeof code === 'string') {
        sets.push(`code = $${idx++}`);
        values.push(code);
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'Nada para atualizar' });
      }
      values.push(id);

      const sql = `UPDATE public.clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING id, name, code`;
      const r = await pgClient.query(sql, values);
      const client = r.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'clients',
        entityId: client.id,
        action: 'update',
        before,
        after: client,
      });

      return res.json(client);
    } catch (err) {
      console.error('Admin update client error:', err);
      return res.status(500).json({ error: 'Erro ao atualizar cliente' });
    }
  });

  router.delete('/clients/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;

      // Block delete if referenced in user_clients or knowledge_base or conversations
      const refUC = await pgClient.query(
        `SELECT COUNT(*)::int AS cnt FROM public.user_clients WHERE client_id = $1`,
        [id]
      );
      const refKB = await pgClient.query(
        `SELECT COUNT(*)::int AS cnt FROM public.knowledge_base WHERE client_id = $1`,
        [id]
      );
      const refConv = await pgClient.query(
        `SELECT COUNT(*)::int AS cnt FROM public.conversations WHERE client_id = $1`,
        [id]
      );
      const totalRef = (refUC.rows[0]?.cnt ?? 0) + (refKB.rows[0]?.cnt ?? 0) + (refConv.rows[0]?.cnt ?? 0);
      if (totalRef > 0) {
        return res.status(409).json({ error: 'Cliente em uso', code: 'CLIENT_IN_USE', referencedCount: totalRef });
      }

      const prev = await pgClient.query(
        `SELECT id, name, code FROM public.clients WHERE id = $1`,
        [id]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }
      const before = prev.rows[0];

      const r = await pgClient.query(`DELETE FROM public.clients WHERE id = $1`, [id]);
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'clients',
        entityId: id,
        action: 'delete',
        before,
        after: null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Admin delete client error:', err);
      return res.status(500).json({ error: 'Erro ao excluir cliente' });
    }
  });

  // Users CRUD
  router.post('/users', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { email, full_name, is_admin = false, status = 'active' } = req.body || {};
      if (!email || !full_name) {
        return res.status(400).json({ error: 'email e full_name são obrigatórios' });
      }

      const ins = await pgClient.query(
        `INSERT INTO public.users (email, full_name, password_hash, must_reset_password, status, is_admin, created_at, updated_at)
         VALUES ($1, $2, NULL, TRUE, $3, $4, now(), now())
         RETURNING id, email, full_name, status, is_admin`,
        [email, full_name, status, Boolean(is_admin)]
      );
      const user = ins.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'users',
        entityId: user.id,
        action: 'create',
        before: null,
        after: user,
      });

      return res.json(user);
    } catch (err) {
      console.error('Admin create user error:', err);
      return res.status(500).json({ error: 'Erro ao criar usuário' });
    }
  });

  router.get('/users', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const r = await pgClient.query(
        `SELECT id, email, full_name, status, is_admin, created_at, updated_at
           FROM public.users
          ORDER BY created_at DESC`
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Admin list users error:', err);
      return res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  });

  router.patch('/users/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;
      const { full_name, status, is_admin, must_reset_password } = req.body || {};

      const prev = await pgClient.query(
        `SELECT id, email, full_name, status, is_admin, must_reset_password
           FROM public.users
          WHERE id = $1`,
        [id]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      const before = prev.rows[0];

      const sets = [];
      const values = [];
      let idx = 1;

      if (typeof full_name === 'string') {
        sets.push(`full_name = $${idx++}`);
        values.push(full_name);
      }
      if (typeof status === 'string') {
        sets.push(`status = $${idx++}`);
        values.push(status);
      }
      if (typeof is_admin === 'boolean') {
        sets.push(`is_admin = $${idx++}`);
        values.push(is_admin);
      }
      if (typeof must_reset_password === 'boolean') {
        sets.push(`must_reset_password = $${idx++}`);
        values.push(must_reset_password);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: 'Nada para atualizar' });
      }
      values.push(id);

      const sql = `UPDATE public.users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING id, email, full_name, status, is_admin, must_reset_password`;
      const r = await pgClient.query(sql, values);
      const user = r.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'users',
        entityId: user.id,
        action: 'update',
        before,
        after: user,
      });

      return res.json(user);
    } catch (err) {
      console.error('Admin update user error:', err);
      return res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
  });

  router.delete('/users/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;

      const prev = await pgClient.query(
        `SELECT id, email, full_name, status FROM public.users WHERE id = $1`,
        [id]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      const before = prev.rows[0];

      // Soft delete: set status to inactive
      const r = await pgClient.query(
        `UPDATE public.users SET status = 'inactive', updated_at = now() WHERE id = $1 RETURNING id, email, full_name, status`,
        [id]
      );
      const user = r.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'users',
        entityId: id,
        action: 'deactivate',
        before,
        after: user,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Admin deactivate user error:', err);
      return res.status(500).json({ error: 'Erro ao desativar usuário' });
    }
  });

  // User-Client link (permissions per client)
  router.post('/user_clients', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const {
        user_id,
        client_id,
        tipo_usuario,
        can_start_chat = false,
        can_edit_kb = false,
        can_view_team_chats = false,
        can_view_all_client_chats = false,
      } = req.body || {};

      if (!user_id || !client_id || !tipo_usuario) {
        return res.status(400).json({ error: 'user_id, client_id e tipo_usuario são obrigatórios', code: 'MISSING_FIELDS' });
      }

      // Normalize and validate tipo_usuario early to avoid PG check violations
      const tipo = String(tipo_usuario).toLowerCase().trim();
      if (tipo !== 'interno' && tipo !== 'externo') {
        return res.status(400).json({ error: "tipo_usuario inválido. Permitidos: 'interno' ou 'externo'", code: 'INVALID_TIPO' });
      }

      // Ensure user exists and is active
      const u = await pgClient.query(
        `SELECT id, status FROM public.users WHERE id = $1`,
        [user_id]
      );
      if (u.rows.length === 0 || u.rows[0].status !== 'active') {
        return res.status(404).json({ error: 'Usuário não encontrado ou inativo', code: 'USER_NOT_FOUND' });
      }

      // Ensure client exists
      const c = await pgClient.query(
        `SELECT id FROM public.clients WHERE id = $1`,
        [client_id]
      );
      if (c.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado', code: 'CLIENT_NOT_FOUND' });
      }

      // Upsert by unique (user_id, client_id)
      const up = await pgClient.query(
        `INSERT INTO public.user_clients (user_id, client_id, tipo_usuario, can_start_chat, can_edit_kb, can_view_team_chats, can_view_all_client_chats, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
         ON CONFLICT (user_id, client_id) DO UPDATE
           SET tipo_usuario = EXCLUDED.tipo_usuario,
               can_start_chat = EXCLUDED.can_start_chat,
               can_edit_kb = EXCLUDED.can_edit_kb,
               can_view_team_chats = EXCLUDED.can_view_team_chats,
               can_view_all_client_chats = EXCLUDED.can_view_all_client_chats,
               updated_at = now()
         RETURNING user_id, client_id, tipo_usuario, can_start_chat, can_edit_kb, can_view_team_chats, can_view_all_client_chats`,
        [user_id, client_id, tipo, can_start_chat, can_edit_kb, can_view_team_chats, can_view_all_client_chats]
      );
      const row = up.rows[0];
      const syntheticId = `${row.user_id}:${row.client_id}`;
      const link = { id: syntheticId, ...row };

      await writeAudit(pgClient, req, {
        entityType: 'user_clients',
        entityId: syntheticId,
        action: 'upsert',
        before: null,
        after: link,
      });

      return res.json(link);
    } catch (err) {
      console.error('Admin upsert user_clients error:', err);
      // Map common PG errors to clearer HTTP responses
      if (err && typeof err === 'object') {
        const code = (err).code;
        const detail = (err).detail || undefined;
        if (code === '23503') {
          // foreign_key_violation
          return res.status(404).json({ error: 'Referência inválida (usuário/cliente inexistente)', code: 'FK_VIOLATION', detail });
        }
        if (code === '23514') {
          // check_violation
          return res.status(400).json({ error: "tipo_usuario inválido. Permitidos: 'interno' ou 'externo'", code: 'CHECK_VIOLATION', detail });
        }
        if (code === '23505') {
          // unique_violation (should not happen due to upsert, but keep defensive)
          return res.status(409).json({ error: 'Conflito de unicidade em (user_id, client_id)', code: 'UNIQUE_VIOLATION', detail });
        }
        if (code === '22P02') {
          // invalid_text_representation (e.g., invalid input syntax for type uuid)
          return res.status(400).json({ error: 'UUID inválido para user_id ou client_id', code: 'INVALID_UUID', detail });
        }
      }
      return res.status(500).json({ error: 'Erro ao salvar permissões do usuário no cliente' });
    }
  });

  router.get('/user_clients', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { user_id, client_id } = req.query || {};

      let sql = `SELECT (uc.user_id::text || ':' || uc.client_id::text) AS id,
                        uc.user_id, uc.client_id, uc.tipo_usuario,
                        uc.can_start_chat, uc.can_edit_kb, uc.can_view_team_chats, uc.can_view_all_client_chats,
                        u.email, u.full_name, c.name AS client_name, c.code AS client_code
                   FROM public.user_clients uc
                   JOIN public.users u ON u.id = uc.user_id
                   JOIN public.clients c ON c.id = uc.client_id`;
      const params = [];
      const where = [];
      if (user_id) {
        where.push(`uc.user_id = $${params.length + 1}`);
        params.push(user_id);
      }
      if (client_id) {
        where.push(`uc.client_id = $${params.length + 1}`);
        params.push(client_id);
      }
      if (where.length > 0) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }
      sql += ` ORDER BY c.name, u.full_name`;

      const r = await pgClient.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Admin list user_clients error:', err);
      return res.status(500).json({ error: 'Erro ao listar vínculos e permissões' });
    }
  });

  router.delete('/user_clients/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;
      const composite = String(id || '');
      const parts = composite.split(':');
      const userId = parts[0];
      const clientId = parts[1];

      if (!userId || !clientId) {
        return res.status(400).json({ error: 'ID inválido. Formato esperado: user_id:client_id', code: 'BAD_COMPOSITE_ID' });
      }

      const prev = await pgClient.query(
        `SELECT user_id, client_id, tipo_usuario, can_start_chat, can_edit_kb, can_view_team_chats, can_view_all_client_chats
           FROM public.user_clients
          WHERE user_id = $1 AND client_id = $2`,
        [userId, clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Vínculo não encontrado' });
      }
      const before = { id: composite, ...prev.rows[0] };

      const r = await pgClient.query(
        `DELETE FROM public.user_clients WHERE user_id = $1 AND client_id = $2`,
        [userId, clientId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Vínculo não encontrado' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'user_clients',
        entityId: composite,
        action: 'delete',
        before,
        after: null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Admin delete user_clients error:', err);
      return res.status(500).json({ error: 'Erro ao excluir vínculo' });
    }
  });

  // Employees (hierarchy)
  router.post('/employees', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { client_id, matricula, nome, matricula_supervisor = null, supervisor = null, funcao } = req.body || {};
      if (!client_id || !matricula || !nome || !funcao) {
        return res.status(400).json({ error: 'client_id, matricula, nome e funcao são obrigatórios' });
      }

      // Upsert by unique (client_id, matricula)
      const up = await pgClient.query(
        `INSERT INTO public.employees (client_id, matricula, nome, matricula_supervisor, supervisor, funcao, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         ON CONFLICT (client_id, matricula) DO UPDATE
           SET nome = EXCLUDED.nome,
               matricula_supervisor = EXCLUDED.matricula_supervisor,
               supervisor = EXCLUDED.supervisor,
               funcao = EXCLUDED.funcao,
               updated_at = now()
         RETURNING id, client_id, matricula, nome, matricula_supervisor, supervisor, funcao`,
        [client_id, matricula, nome, matricula_supervisor, supervisor, funcao]
      );
      const emp = up.rows[0];

      await writeAudit(pgClient, req, {
        entityType: 'employees',
        entityId: emp.id,
        action: 'upsert',
        before: null,
        after: emp,
      });

      return res.json(emp);
    } catch (err) {
      console.error('Admin upsert employee error:', err);
      return res.status(500).json({ error: 'Erro ao salvar funcionário' });
    }
  });

  router.get('/employees', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { client_id, matricula_supervisor } = req.query || {};
      let sql = `SELECT id, client_id, matricula, nome, matricula_supervisor, supervisor, funcao
                   FROM public.employees`;
      const params = [];
      const where = [];
      if (client_id) {
        where.push(`client_id = $${params.length + 1}`);
        params.push(client_id);
      }
      if (matricula_supervisor) {
        where.push(`matricula_supervisor = $${params.length + 1}`);
        params.push(matricula_supervisor);
      }
      if (where.length > 0) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }
      sql += ` ORDER BY nome ASC`;

      const r = await pgClient.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Admin list employees error:', err);
      return res.status(500).json({ error: 'Erro ao listar funcionários' });
    }
  });

  router.delete('/employees/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;

      const prev = await pgClient.query(
        `SELECT id, client_id, matricula FROM public.employees WHERE id = $1`,
        [id]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }
      const before = prev.rows[0];

      // Block delete if referenced by links
      const ref = await pgClient.query(
        `SELECT COUNT(*)::int AS cnt FROM public.user_employee_links WHERE client_id = $1 AND matricula = $2`,
        [before.client_id, before.matricula]
      );
      if ((ref.rows[0]?.cnt ?? 0) > 0) {
        return res.status(409).json({ error: 'Funcionário vinculado a usuário', code: 'EMPLOYEE_LINKED' });
      }

      const r = await pgClient.query(`DELETE FROM public.employees WHERE id = $1`, [id]);
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'employees',
        entityId: id,
        action: 'delete',
        before,
        after: null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Admin delete employee error:', err);
      return res.status(500).json({ error: 'Erro ao excluir funcionário' });
    }
  });

  // Links: associate user to employee (matricula) per client
  router.post('/links', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { user_id, client_id, matricula } = req.body || {};
      if (!user_id || !client_id || !matricula) {
        return res.status(400).json({ error: 'user_id, client_id e matricula são obrigatórios' });
      }

      const existing = await pgClient.query(
        `SELECT user_id, client_id FROM public.user_employee_links WHERE user_id = $1 AND client_id = $2`,
        [user_id, client_id]
      );
      let row;
      if (existing.rows.length > 0) {
        const r = await pgClient.query(
          `UPDATE public.user_employee_links
              SET matricula = $3, updated_at = now()
            WHERE user_id = $1 AND client_id = $2
          RETURNING user_id, client_id, matricula`,
          [user_id, client_id, matricula]
        );
        row = r.rows[0];
      } else {
        const r = await pgClient.query(
          `INSERT INTO public.user_employee_links (user_id, client_id, matricula, created_at, updated_at)
           VALUES ($1, $2, $3, now(), now())
           RETURNING user_id, client_id, matricula`,
          [user_id, client_id, matricula]
        );
        row = r.rows[0];
      }
      const syntheticId = `${row.user_id}:${row.client_id}`;
      const link = { id: syntheticId, ...row };

      await writeAudit(pgClient, req, {
        entityType: 'user_employee_links',
        entityId: syntheticId,
        action: 'upsert',
        before: null,
        after: link,
      });

      return res.json(link);
    } catch (err) {
      console.error('Admin upsert link error:', err);
      return res.status(500).json({ error: 'Erro ao vincular usuário à matrícula' });
    }
  });

  router.get('/links', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { user_id, client_id } = req.query || {};
      let sql = `SELECT (uel.user_id::text || ':' || uel.client_id::text) AS id, uel.user_id, uel.client_id, uel.matricula,
                        u.email, u.full_name, c.name AS client_name, e.nome AS funcionario_nome, e.funcao
                   FROM public.user_employee_links uel
              LEFT JOIN public.users u ON u.id = uel.user_id
              LEFT JOIN public.clients c ON c.id = uel.client_id
              LEFT JOIN public.employees e ON e.client_id = uel.client_id AND e.matricula = uel.matricula`;
      const params = [];
      const where = [];
      if (user_id) {
        where.push(`uel.user_id = $${params.length + 1}`);
        params.push(user_id);
      }
      if (client_id) {
        where.push(`uel.client_id = $${params.length + 1}`);
        params.push(client_id);
      }
      if (where.length > 0) {
        sql += ` WHERE ${where.join(' AND ')}`;
      }
      sql += ` ORDER BY u.full_name`;

      const r = await pgClient.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Admin list links error:', err);
      return res.status(500).json({ error: 'Erro ao listar vínculos' });
    }
  });

  router.delete('/links/:id', async (req, res) => {
    const admin = await ensureAdmin(pgClient, req, res);
    if (!admin) return;

    try {
      const { id } = req.params;
      const composite = String(id || '');
      const parts = composite.split(':');
      const delUserId = parts[0];
      const delClientId = parts[1];

      if (!delUserId || !delClientId) {
        return res.status(400).json({ error: 'ID inválido. Formato esperado: user_id:client_id', code: 'BAD_COMPOSITE_ID' });
      }

      const prev = await pgClient.query(
        `SELECT user_id, client_id, matricula
           FROM public.user_employee_links
          WHERE user_id = $1 AND client_id = $2`,
        [delUserId, delClientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Vínculo não encontrado' });
      }
      const before = { id: composite, ...prev.rows[0] };

      const r = await pgClient.query(
        `DELETE FROM public.user_employee_links WHERE user_id = $1 AND client_id = $2`,
        [delUserId, delClientId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Vínculo não encontrado' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'user_employee_links',
        entityId: composite,
        action: 'delete',
        before,
        after: null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Admin delete link error:', err);
      return res.status(500).json({ error: 'Erro ao excluir vínculo' });
    }
  });

  return router;
}