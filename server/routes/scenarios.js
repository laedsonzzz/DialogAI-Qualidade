import express from 'express';
import { writeAudit } from '../middleware/audit.js';
import { requireCanManageScenarios } from '../middleware/permissions.js';

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

  /**
   * DELETE /api/scenarios/:id
   * Remove completamente um cenário do cliente e recursos vinculados no metadata:
   * - Remove scenario_profiles
   * - Remove knowledge_base (process_kb_id), se existir e pertencer ao cliente
   * - Remove kb_chunks e kb_sources (kb_source_operator_id), se existir e pertencer ao cliente
   * - Remove o próprio cenário
   */
  router.delete('/:id', requireCanManageScenarios(), async (req, res) => {
    try {
      const { id } = req.params;

      // Buscar cenário do cliente
      const prev = await pgClient.query(
        `SELECT id, client_id, motivo_label, title, status, metadata
           FROM public.scenarios
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }
      const scenario = prev.rows[0];

      // Verificar referências em conversas (inclui conversas soft-deletadas)
      const ref = await pgClient.query(
        `SELECT COUNT(*)::int AS cnt
           FROM public.conversations
          WHERE client_id = $1 AND scenario_id = $2`,
        [req.clientId, id]
      );
      if ((ref.rows[0]?.cnt ?? 0) > 0) {
        return res.status(409).json({
          error: 'Cenário em uso em conversas. Arquive para ocultar sem remover histórico.',
          code: 'SCENARIO_IN_USE',
          referencedCount: ref.rows[0].cnt
        });
      }
      
      // Inicia transação
      await pgClient.query('BEGIN');
      
      // Remove perfis vinculados ao cenário
      await pgClient.query(
        `DELETE FROM public.scenario_profiles
          WHERE scenario_id = $1`,
        [id]
      );

      // Remover recursos vinculados do metadata, quando presentes e pertencentes ao cliente
      let referencedCount = 0;
      try {
        const meta = scenario.metadata || {};
        const processKbId = meta?.process_kb_id || meta?.processKbId || null;
        const kbSourceOperatorId = meta?.kb_source_operator_id || meta?.kbSourceOperatorId || null;

        if (processKbId) {
          const delKB = await pgClient.query(
            `DELETE FROM public.knowledge_base
               WHERE id = $1 AND client_id = $2`,
            [processKbId, req.clientId]
          );
          referencedCount += delKB.rowCount || 0;
        }

        if (kbSourceOperatorId) {
          // Apagar chunks primeiro
          const delChunks = await pgClient.query(
            `DELETE FROM public.kb_chunks
               WHERE source_id = $1 AND client_id = $2`,
            [kbSourceOperatorId, req.clientId]
          );
          referencedCount += delChunks.rowCount || 0;

          // Apagar source
          const delSrc = await pgClient.query(
            `DELETE FROM public.kb_sources
               WHERE id = $1 AND client_id = $2`,
            [kbSourceOperatorId, req.clientId]
          );
          referencedCount += delSrc.rowCount || 0;
        }
      } catch (refErr) {
        // não bloqueia, apenas registra e continua
        console.warn('Erro ao remover recursos vinculados ao cenário:', refErr);
      }

      // Remove o próprio cenário
      const delScenario = await pgClient.query(
        `DELETE FROM public.scenarios
           WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (delScenario.rowCount === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'scenarios',
        entityId: id,
        action: 'delete',
        before: scenario,
        after: null,
        extra: { referencedCount },
      });

      await pgClient.query('COMMIT');

      return res.json({ ok: true, referencedCount });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('Delete scenario error:', err);
      return res.status(500).json({ error: 'Erro ao remover cenário' });
    }
  });

  return router;
}

export default { scenariosRoutes };