/**
 * Middleware de tenant:
 * - Exige header X-Client-Id
 * - Valida associação do usuário (req.user.id) ao cliente em public.user_clients
 * - Anexa req.clientId, req.userPerms e vínculo opcional de matrícula (req.userEmployee)
 */
export function requireTenant(pgClient) {
  return async function (req, res, next) {
    try {
      const clientId = (req.headers['x-client-id'] || '').toString().trim();
      if (!clientId) {
        return res.status(400).json({ error: 'X-Client-Id é obrigatório' });
      }
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Não autenticado' });
      }

      // Verifica se o cliente existe
      const c = await pgClient.query(
        `SELECT id, name, code FROM public.clients WHERE id = $1`,
        [clientId]
      );
      if (c.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      // Verifica associação e carrega permissões
      const perms = await pgClient.query(
        `SELECT uc.user_id, uc.client_id, uc.tipo_usuario,
                uc.can_start_chat, uc.can_edit_kb, uc.can_view_team_chats, uc.can_view_all_client_chats
           FROM public.user_clients uc
          WHERE uc.user_id = $1 AND uc.client_id = $2`,
        [req.user.id, clientId]
      );
      if (perms.rows.length === 0) {
        return res.status(403).json({ error: 'Usuário não possui acesso a este cliente' });
      }
      const p = perms.rows[0];

      // Carrega vínculo de matrícula por cliente (se existir)
      const link = await pgClient.query(
        `SELECT uel.matricula
           FROM public.user_employee_links uel
          WHERE uel.user_id = $1 AND uel.client_id = $2`,
        [req.user.id, clientId]
      );

      req.clientId = clientId;
      req.userPerms = {
        tipo_usuario: p.tipo_usuario,
        can_start_chat: p.can_start_chat,
        can_edit_kb: p.can_edit_kb,
        can_view_team_chats: p.can_view_team_chats,
        can_view_all_client_chats: p.can_view_all_client_chats,
      };
      req.userEmployee = {
        matricula: link.rows[0]?.matricula || null,
      };

      return next();
    } catch (err) {
      console.error('requireTenant error:', err);
      return res.status(500).json({ error: 'Erro ao validar tenant' });
    }
  };
}