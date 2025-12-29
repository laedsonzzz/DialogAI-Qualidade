import { jwtVerify } from 'jose';

/**
 * Retorna a chave secreta do JWT a partir da env.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  return new TextEncoder().encode(secret);
}

/**
 * Middleware: requer autenticação via JWT (Authorization: Bearer <token>).
 * - Verifica token
 * - Carrega usuário do banco
 * - Verifica status 'active'
 * - Anexa req.user = { id, email, full_name }
 */
export function requireAuth(pgClient) {
  return async function (req, res, next) {
    try {
      const authz = req.headers.authorization || '';
      if (!authz.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Não autenticado' });
      }
      const token = authz.slice('Bearer '.length);

      let payload;
      try {
        const result = await jwtVerify(token, getJwtSecret());
        payload = result.payload;
      } catch (_e) {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
      }

      const userId = payload.sub;
      if (!userId) {
        return res.status(401).json({ error: 'Token sem subject' });
      }

      const u = await pgClient.query(
        `SELECT id, email, full_name, status, is_admin
           FROM public.users
          WHERE id = $1
          LIMIT 1`,
        [userId]
      );

      if (u.rows.length === 0) {
        return res.status(401).json({ error: 'Usuário não encontrado' });
      }
      const user = u.rows[0];
      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Usuário inativo' });
      }

      req.user = {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        is_admin: user.is_admin === true,
      };

      return next();
    } catch (err) {
      console.error('requireAuth error:', err);
      return res.status(500).json({ error: 'Erro de autenticação' });
    }
  };
}