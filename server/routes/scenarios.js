import express from 'express';
import { writeAudit } from '../middleware/audit.js';

/**
 * Rotas de Cenários aprovados (principais) por cliente.
 *
 * Prefixo esperado:
 *   app.use('/api/scenarios', requireAuth(pgClient), requireTenant(pgClient), scenariosRoutes(pgClient))
 *
 * Endpoints:
 * - GET /api/scenarios: lista cenários do cliente com perfis (aggregados)
 * - PATCH /api/scenarios/:id: atualiza status (active|archived)
 */
export function scenariosRoutes(pgClient) {
  const router = express.Router();

  /**
   * GET /api/scenarios
   * Query: status=active|archived|all
   * Retorna cenários com perfis agregados.
   */
  router.get('/', async (req, res) => {
    try {
      const statusParam = String((req.query?.status ?? 'active')).toLowerCase();

      let sql = `
        SELECT s.id, s.client_id, s.motivo_label, s.title, s.status, s.metadata, s.created_at, s.updated_at,
               COALESCE(array_agg(sp.profile_label ORDER BY sp.profile_label) FILTER (WHERE sp.profile_label IS NOT NULL), '{}') AS profiles
          FROM public.scenarios s
     LEFT JOIN public.scenario_profiles sp ON sp.scenario_id = s.id
         WHERE s.client_id = $1`;
      const params = [req.clientId];

      if (statusParam === 'active' || statusParam === 'archived') {
        sql += ' AND s.status = $2';
        params.push(statusParam);
      }
      sql += ' GROUP BY s.id ORDER BY s.title ASC';

      const r = await pgClient.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('List scenarios error:', err);
      return res.status(500).json({ error: 'Erro ao listar cenários' });
    }
  });

  /**
   * PATCH /api/scenarios/:id
   * Body: { status: 'active'|'archived' }
   * Atualiza status de um cenário do cliente.
   */
  router.patch('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const normalized = String(req.body?.status || '').toLowerCase();
      if (!['active', 'archived'].includes(normalized)) {
        return res.status(400).json({ error: 'Status inválido', allowed: ['active', 'archived'] });
      }

      // Buscar estado anterior
      const prev = await pgClient.query(
        `SELECT id, client_id, motivo_label, title, status, metadata
           FROM public.scenarios
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }
      const before = prev.rows[0];

      const upd = await pgClient.query(
        `UPDATE public.scenarios
            SET status = $3, updated_at = now()
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId, normalized]
      );
      if (upd.rowCount === 0) {
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'scenarios',
        entityId: id,
        action: 'update_status',
        before,
        after: { ...before, status: normalized },
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Update scenario status error:', err);
      return res.status(500).json({ error: 'Erro ao atualizar status do cenário' });
    }
  });

  return router;
}

export default { scenariosRoutes };