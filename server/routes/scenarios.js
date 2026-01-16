import express from 'express';
import { writeAudit } from '../middleware/audit.js';
import { requireCanManageScenarios } from '../middleware/permissions.js';
import { chunkText } from '../services/chunker.js';
import { createAzureEmbedder } from '../services/embeddings.js';
import { normalizeText } from '../services/ingestion.js';

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
      // Diagnóstico: em algumas instalações, a tabela "conversations" não possui a coluna scenario_id.
      // Nesses casos, fazemos fallback para comparar pelo campo textual "scenario" (título).
      let refCount = 0;
      try {
        const ref = await pgClient.query(
          `SELECT COUNT(*)::int AS cnt
             FROM public.conversations
            WHERE client_id = $1 AND scenario_id = $2`,
          [req.clientId, id]
        );
        refCount = ref.rows[0]?.cnt ?? 0;
        console.debug('Verificação de referências por scenario_id concluída', { scenario_id: id, refCount });
      } catch (e) {
        // Fallback: coluna scenario_id ausente -> contar por título do cenário (campo textual "scenario")
        console.warn('Fallback: conversations.scenario_id ausente; verificando referências por título do cenário.', { scenario_id: id, title: scenario.title });
        const refByTitle = await pgClient.query(
          `SELECT COUNT(*)::int AS cnt
             FROM public.conversations
            WHERE client_id = $1 AND scenario = $2`,
          [req.clientId, scenario.title]
        );
        refCount = refByTitle.rows[0]?.cnt ?? 0;
      }
      if (refCount > 0) {
        return res.status(409).json({
          error: 'Cenário em uso em conversas. Arquive para ocultar sem remover histórico.',
          code: 'SCENARIO_IN_USE',
          referencedCount: refCount
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

  /**
   * GET /api/scenarios/:id/details
   * Retorna detalhes de edição do cenário (UI do Lab):
   * - title, motivo_label, profiles[], patterns[]
   * - process_text (via metadata.process_kb_id -> knowledge_base.content)
   * - operator_guidelines[] (reconstruído de kb_chunks do metadata.kb_source_operator_id)
   */
  router.get('/:id/details', async (req, res) => {
    try {
      const { id } = req.params;
      // Carregar cenário do cliente
      const sr = await pgClient.query(
        `SELECT id, client_id, motivo_label, title, status, metadata
           FROM public.scenarios
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (sr.rows.length === 0) {
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }
      const scenario = sr.rows[0] || {};
      const metadata = scenario.metadata || {};
      const patterns = Array.isArray(metadata?.patterns) ? metadata.patterns : [];

      // Perfis
      const pr = await pgClient.query(
        `SELECT profile_label
           FROM public.scenario_profiles
          WHERE scenario_id = $1
          ORDER BY profile_label ASC`,
        [id]
      );
      const profiles = (pr.rows || []).map((r) => r.profile_label);

      // process_text pelo KB de processo (quando existir)
      let process_text = '';
      const processKbId = metadata?.process_kb_id || metadata?.processKbId || null;
      if (processKbId) {
        const kb = await pgClient.query(
          `SELECT content FROM public.knowledge_base WHERE id = $1 AND client_id = $2`,
          [processKbId, req.clientId]
        );
        if (kb.rows.length > 0) {
          process_text = kb.rows[0].content || '';
        }
      }

      // operator_guidelines[] reconstruído a partir de chunks da fonte kb_operator (quando existir)
      let operator_guidelines = [];
      const kbSourceOperatorId = metadata?.kb_source_operator_id || metadata?.kbSourceOperatorId || null;
      if (kbSourceOperatorId) {
        const ch = await pgClient.query(
          `SELECT content, chunk_no
             FROM public.kb_chunks
            WHERE source_id = $1 AND client_id = $2
            ORDER BY chunk_no ASC`,
          [kbSourceOperatorId, req.clientId]
        );
        const fullText = (ch.rows || []).map((r) => String(r.content || '')).join('\n');
        // Extrai linhas no formato "- (n) texto"
        const regex = /-\s*\(\d+\)\s*(.+)/g;
        const out = [];
        let m;
        while ((m = regex.exec(fullText)) !== null) {
          const s = String(m[1] || '').trim();
          if (s) out.push(s.slice(0, 200));
          if (out.length >= 20) break;
        }
        // Fallback: se não capturou nada, tenta dividir por linhas
        if (out.length === 0) {
          const fallback = fullText.split(/\r?\n/).map((s) => String(s || '').trim()).filter(Boolean);
          operator_guidelines = fallback.slice(0, 20);
        } else {
          operator_guidelines = out;
        }
      }

      return res.json({
        id: scenario.id,
        motivo_label: scenario.motivo_label,
        title: scenario.title,
        profiles,
        process_text,
        operator_guidelines,
        patterns,
      });
    } catch (err) {
      console.error('Get scenario details error:', err);
      return res.status(500).json({ error: 'Erro ao carregar detalhes do cenário' });
    }
  });

  /**
   * POST /api/scenarios/:id/fork
   * - Arquiva o cenário atual (status='archived')
   * - Cria uma nova versão com motivo_label diferente (ex.: "Motivo v2", "Motivo v3", ...)
   * - Atualiza/gera KB de processo e KB Operador a partir do payload (UI do Lab)
   * Body:
   * {
   *   scenario_title: string,
   *   customer_profiles: string[],
   *   process_text: string|null,
   *   operator_guidelines: string[],
   *   patterns: string[]
   * }
   */
  router.post('/:id/fork', requireCanManageScenarios(), async (req, res) => {
    try {
      const { id } = req.params;
      const body = req.body || {};
      let {
        scenario_title,
        customer_profiles,
        process_text,
        operator_guidelines,
        patterns,
      } = body;

      // Normalizações e limites
      scenario_title = typeof scenario_title === 'string' ? scenario_title.trim().slice(0, 200) : '';
      if (!scenario_title) {
        return res.status(400).json({ error: 'scenario_title é obrigatório' });
      }
      customer_profiles = Array.isArray(customer_profiles)
        ? customer_profiles.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6)
        : [];
      process_text = typeof process_text === 'string' ? process_text : null;
      operator_guidelines = Array.isArray(operator_guidelines)
        ? operator_guidelines.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20)
        : [];
      patterns = Array.isArray(patterns)
        ? patterns.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20)
        : [];

      // Carregar cenário atual
      const sr = await pgClient.query(
        `SELECT id, client_id, motivo_label, title, status, metadata
           FROM public.scenarios
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (sr.rows.length === 0) {
        return res.status(404).json({ error: 'Cenário não encontrado neste cliente' });
      }
      const scenario = sr.rows[0];
      const baseLabel = String(scenario.motivo_label || '').trim();

      // Calcular novo motivo_label "vN"
      // Busca rótulos existentes base e base vN
      const ex = await pgClient.query(
        `SELECT motivo_label
           FROM public.scenarios
          WHERE client_id = $1
            AND (motivo_label = $2 OR motivo_label LIKE $3)
          ORDER BY motivo_label ASC`,
        [req.clientId, baseLabel, `${baseLabel} v%`]
      );
      // Próximo sufixo vN a ser aplicado no cenário anterior (arquivado)
      let maxV = 0;
      for (const r of (ex.rows || [])) {
        const ml = String(r.motivo_label || '');
        const m = ml.match(/\sv(\d+)$/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n)) maxV = Math.max(maxV, n);
        }
      }
      const nextV = (maxV || 0) + 1; // começa em v1 quando não houver versões
      const previousNewLabel = `${baseLabel} v${nextV}`;
      // Para a nova versão ativa, mantém o motivo sem sufixo
      const newMotivoLabel = baseLabel;

      const embedder = createAzureEmbedder();
      await pgClient.query('BEGIN');

      // Criar KB de processo (opcional)
      let processKbId = null;
      if (process_text && process_text.trim().length > 0) {
        const title = `Processo - ${scenario_title}`;
        const category = 'processo';
        const rKB = await pgClient.query(
          `INSERT INTO public.knowledge_base (title, category, content, client_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [title, category, process_text, req.clientId]
        );
        processKbId = rKB.rows[0].id;
      }

      // Criar KB Operador (opcional)
      let kbSourceOperatorId = null;
      if (operator_guidelines.length > 0) {
        const text = normalizeText(operator_guidelines.map((g, idx) => `- (${idx + 1}) ${String(g || '').trim()}`).join('\n'));
        const chunks = chunkText(text, {
          chunkTokens: Number(process.env.RAG_CHUNK_TOKENS || 800),
          overlapTokens: Number(process.env.RAG_CHUNK_OVERLAP || 200),
        });
        const embeddings = await embedder.embed(chunks.map((c) => c.content));

        // kb_sources
        const srcIns = await pgClient.query(
          `INSERT INTO public.kb_sources (client_id, kb_type, source_kind, title, status, created_by)
           VALUES ($1, $2, 'free_text', $3, 'active', $4)
           RETURNING id`,
          [req.clientId, 'operador', `Diretrizes - ${scenario_title}`, req.user?.id || null]
        );
        kbSourceOperatorId = srcIns.rows[0].id;

        // kb_chunks
        for (let i = 0; i < chunks.length; i++) {
          const emb = embeddings[i] || [];
          const vecLit = `[${emb.map((x) => (typeof x === 'number' ? x : Number(x) || 0)).join(',')}]`;
          await pgClient.query(
            `INSERT INTO public.kb_chunks (source_id, client_id, kb_type, chunk_no, content, tokens, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [kbSourceOperatorId, req.clientId, 'operador', i + 1, chunks[i].content, chunks[i].tokens || null, vecLit]
          );
        }
      }

      // Monta metadata novo
      const metadata = {
        previous_scenario_id: scenario.id,
        patterns,
        process_kb_id: processKbId,
        kb_source_operator_id: kbSourceOperatorId,
      };

      // Arquivar KB de processo anterior (quando existir)
      const prevMeta = scenario.metadata || {};
      const prevProcessKbId = prevMeta?.process_kb_id || prevMeta?.processKbId || null;
      if (prevProcessKbId) {
        await pgClient.query(
          `UPDATE public.knowledge_base
              SET status = 'archived', updated_at = now()
            WHERE id = $1 AND client_id = $2`,
          [prevProcessKbId, req.clientId]
        );
      }
      const prevKbSourceOperatorId = prevMeta?.kb_source_operator_id || prevMeta?.kbSourceOperatorId || null;
      if (prevKbSourceOperatorId) {
        await pgClient.query(
          `UPDATE public.kb_sources
              SET status = 'archived', updated_at = now()
            WHERE id = $1 AND client_id = $2`,
          [prevKbSourceOperatorId, req.clientId]
        );
      }

      // Arquivar e renomear cenário antigo antes de inserir o novo (evita conflito de motivo_label)
      await pgClient.query(
        `UPDATE public.scenarios
            SET status = 'archived', motivo_label = $3, updated_at = now()
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId, previousNewLabel]
      );

      // Inserir novo cenário ativo
      const sIns = await pgClient.query(
        `INSERT INTO public.scenarios (client_id, motivo_label, title, metadata, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id`,
        [req.clientId, newMotivoLabel, scenario_title, JSON.stringify(metadata), req.user?.id || null]
      );
      const newScenarioId = sIns.rows[0].id;

      // Perfis
      for (const p of customer_profiles) {
        const label = String(p || '').trim();
        if (!label) continue;
        await pgClient.query(
          `INSERT INTO public.scenario_profiles (scenario_id, profile_label)
           VALUES ($1, $2)
           ON CONFLICT (scenario_id, profile_label) DO NOTHING`,
          [newScenarioId, label]
        );
      }

      // Cenário antigo já arquivado e rotulado acima

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'scenarios',
        entityId: newScenarioId,
        action: 'fork',
        before: {
          id: scenario.id,
          motivo_label: scenario.motivo_label,
          title: scenario.title,
          status: scenario.status,
        },
        after: {
          id: newScenarioId,
          motivo_label: newMotivoLabel,
          title: scenario_title,
          patterns_count: patterns.length,
          process_kb_id: processKbId,
          kb_source_operator_id: kbSourceOperatorId,
          archived_previous: true,
        },
      });

      await pgClient.query('COMMIT');

      return res.json({ ok: true, scenario_id: newScenarioId, motivo_label: newMotivoLabel });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('Fork scenario error:', err);
      return res.status(500).json({ error: 'Erro ao criar nova versão do cenário' });
    }
  });

  return router;
}
 
export default { scenariosRoutes };