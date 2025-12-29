import express from 'express';
import { requireCanEditKB } from '../middleware/permissions.js';
import { writeAudit } from '../middleware/audit.js';

/**
 * Rotas de Prompts e Versionamento por cliente
 *
 * Requisitos de middleware para montagem em server/index.js:
 *   app.use('/api/prompts', requireAuth(pgClient), requireTenant(pgClient), promptsRoutes(pgClient))
 *
 * Permissões:
 *  - GET: qualquer usuário autenticado no cliente (somente requireAuth + requireTenant no prefixo)
 *  - POST/PATCH: requireCanEditKB()
 */
export function promptsRoutes(pgClient) {
  const router = express.Router();

  /**
   * GET /api/prompts?include=active|all
   * - include=active (default): retorna prompts com versão ativa
   * - include=all: retorna prompts com todas as versões
   */
  router.get('/', async (req, res) => {
    try {
      const clientId = req.clientId;
      const include = String(req.query?.include || 'active').toLowerCase();

      if (include === 'all') {
        const r = await pgClient.query(
          `SELECT p.id AS prompt_id, p.name,
                  pv.id AS version_id, pv.version, pv.is_active, pv.content, pv.metadata, pv.created_at
             FROM public.prompts p
             LEFT JOIN public.prompt_versions pv ON pv.prompt_id = p.id
            WHERE p.client_id = $1
            ORDER BY p.name ASC, pv.version DESC NULLS LAST`,
          [clientId]
        );

        // Agrupar por prompt
        const map = new Map();
        for (const row of r.rows) {
          if (!map.has(row.prompt_id)) {
            map.set(row.prompt_id, {
              id: row.prompt_id,
              name: row.name,
              versions: [],
            });
          }
          if (row.version_id) {
            map.get(row.prompt_id).versions.push({
              id: row.version_id,
              version: row.version,
              is_active: row.is_active,
              content: row.content,
              metadata: row.metadata,
              created_at: row.created_at,
            });
          }
        }
        return res.json(Array.from(map.values()));
      } else {
        // active
        const r = await pgClient.query(
          `SELECT p.id AS prompt_id, p.name,
                  pv.id AS version_id, pv.version, pv.is_active, pv.content, pv.metadata, pv.created_at
             FROM public.prompts p
             LEFT JOIN public.prompt_versions pv
               ON pv.prompt_id = p.id AND pv.is_active = TRUE
            WHERE p.client_id = $1
            ORDER BY p.name ASC`,
          [clientId]
        );

        return res.json(
          r.rows.map((row) => ({
            id: row.prompt_id,
            name: row.name,
            active_version: row.version_id
              ? {
                  id: row.version_id,
                  version: row.version,
                  content: row.content,
                  metadata: row.metadata,
                  created_at: row.created_at,
                }
              : null,
          }))
        );
      }
    } catch (err) {
      console.error('Prompts list error:', err);
      return res.status(500).json({ error: 'Erro ao listar prompts' });
    }
  });

  /**
   * POST /api/prompts
   * Body: { name }
   * Cria um prompt para o cliente atual.
   */
  router.post('/', requireCanEditKB(), async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Nome é obrigatório' });
      }
      const clientId = req.clientId;
      const r = await pgClient.query(
        `INSERT INTO public.prompts (client_id, name)
         VALUES ($1, $2)
         RETURNING id, name, created_at, updated_at`,
        [clientId, name.trim()]
      );
      const pr = r.rows[0];

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'prompts',
        entityId: pr.id,
        action: 'create',
        before: null,
        after: { id: pr.id, name: pr.name, client_id: clientId },
      });

      return res.json({ ok: true, id: pr.id, name: pr.name });
    } catch (err) {
      // Tratamento de violação de unicidade: UNIQUE (client_id, name)
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Já existe um prompt com este nome para o cliente' });
      }
      console.error('Prompts create error:', err);
      return res.status(500).json({ error: 'Erro ao criar prompt' });
    }
  });

  /**
   * POST /api/prompts/:id/versions
   * Body: { content, metadata?, activate? }
   * Cria nova versão (auto-incremental) para o prompt do cliente.
   * Se activate=true, ativa essa versão e desativa as demais.
   */
  router.post('/:id/versions', requireCanEditKB(), async (req, res) => {
    const { id } = req.params;
    const { content, metadata, activate } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content é obrigatório' });
    }

    try {
      // Garantir que o prompt pertence ao cliente
      const p = await pgClient.query(
        `SELECT id, client_id, name FROM public.prompts WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (p.rows.length === 0) {
        return res.status(404).json({ error: 'Prompt não encontrado neste cliente' });
      }

      // Descobrir próximo número de versão
      const v = await pgClient.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM public.prompt_versions WHERE prompt_id = $1`,
        [id]
      );
      const nextVersion = v.rows[0]?.next || 1;

      // Criar nova versão
      const ins = await pgClient.query(
        `INSERT INTO public.prompt_versions (prompt_id, version, content, metadata, is_active)
         VALUES ($1, $2, $3, $4::jsonb, FALSE)
         RETURNING id, version, is_active, created_at`,
        [id, nextVersion, content, metadata ? JSON.stringify(metadata) : '{}']
      );
      const created = ins.rows[0];

      // Ativar se solicitado
      let activated = false;
      if (activate === true) {
        await pgClient.query('BEGIN');
        try {
          await pgClient.query(
            `UPDATE public.prompt_versions SET is_active = FALSE WHERE prompt_id = $1`,
            [id]
          );
          await pgClient.query(
            `UPDATE public.prompt_versions SET is_active = TRUE WHERE prompt_id = $1 AND version = $2`,
            [id, nextVersion]
          );
          await pgClient.query('COMMIT');
          activated = true;
        } catch (e) {
          await pgClient.query('ROLLBACK');
          throw e;
        }
      }

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'prompt_versions',
        entityId: created.id,
        action: 'create_version',
        before: null,
        after: {
          prompt_id: id,
          version: created.version,
          is_active: activated,
        },
      });

      return res.json({
        ok: true,
        id: created.id,
        version: created.version,
        is_active: activated || created.is_active === true,
        created_at: created.created_at,
      });
    } catch (err) {
      console.error('Prompt version create error:', err);
      return res.status(500).json({ error: 'Erro ao criar versão do prompt' });
    }
  });

  /**
   * PATCH /api/prompts/:id/versions/:version/activate
   * Ativa uma versão específica e desativa as demais para esse prompt.
   */
  router.patch('/:id/versions/:version/activate', requireCanEditKB(), async (req, res) => {
    const { id, version } = req.params;
    try {
      // Verificar prompt do cliente
      const p = await pgClient.query(
        `SELECT id FROM public.prompts WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (p.rows.length === 0) {
        return res.status(404).json({ error: 'Prompt não encontrado neste cliente' });
      }

      // Ativar dentro de transação
      await pgClient.query('BEGIN');
      try {
        const d1 = await pgClient.query(
          `UPDATE public.prompt_versions SET is_active = FALSE WHERE prompt_id = $1`,
          [id]
        );
        const d2 = await pgClient.query(
          `UPDATE public.prompt_versions SET is_active = TRUE WHERE prompt_id = $1 AND version = $2`,
          [id, version]
        );
        await pgClient.query('COMMIT');

        if (d2.rowCount === 0) {
          return res.status(404).json({ error: 'Versão não encontrada' });
        }

        // Obter id da versão ativada
        const r = await pgClient.query(
          `SELECT id FROM public.prompt_versions WHERE prompt_id = $1 AND version = $2`,
          [id, version]
        );
        const pvId = r.rows[0]?.id;

        // Auditoria
        await writeAudit(pgClient, req, {
          entityType: 'prompt_versions',
          entityId: pvId || `${id}:${version}`,
          action: 'activate',
          before: null,
          after: { prompt_id: id, activated_version: Number(version), deactivated_count: d1.rowCount },
        });

        return res.json({ ok: true });
      } catch (e) {
        await pgClient.query('ROLLBACK');
        throw e;
      }
    } catch (err) {
      console.error('Prompt version activate error:', err);
      return res.status(500).json({ error: 'Erro ao ativar versão do prompt' });
    }
  });

  return router;
}