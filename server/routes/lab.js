import express from 'express';
import multer from 'multer';
import { writeAudit } from '../middleware/audit.js';
import { requireCanManageScenarios } from '../middleware/permissions.js';
import { parseTranscriptBase } from '../services/lab_parser.js';
import { startLabAnalysis } from '../jobs/lab_analysis.js';
import { chunkText } from '../services/chunker.js';
import { createAzureEmbedder } from '../services/embeddings.js';
import { normalizeText } from '../services/ingestion.js';

/**
 * Rotas do Laboratório de Cenários por cliente
 *
 * Prefixo de montagem esperado em server/index.js:
 *   app.use('/api/lab', requireAuth(pgClient), requireTenant(pgClient), labRoutes(pgClient))
 *
 * Permissões:
 * - Todas exigem requireCanManageScenarios()
 */

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: Math.max(1, Number(process.env.UPLOAD_MAX_MB || 10)) * 1024 * 1024, // por arquivo
  },
});

function computeStatsFromRows(rows) {
  const ids = new Set();
  const motivoIds = new Map(); // motivo -> Set(ids)
  for (const r of rows) {
    ids.add(r.atendimento_id);
    const key = String(r.motivo || '').trim();
    if (!motivoIds.has(key)) motivoIds.set(key, new Set());
    motivoIds.get(key).add(r.atendimento_id);
  }
  const motivoDistinctIds = {};
  for (const [motivo, setIds] of motivoIds.entries()) {
    motivoDistinctIds[motivo] = setIds.size;
  }
  return { totalDistinctIds: ids.size, motivoDistinctIds };
}

export function labRoutes(pgClient) {
  const router = express.Router();

  /**
   * POST /api/lab/scenarios/upload
   * Multipart: file (CSV ou XLSX)
   * - Cria lab_runs
   * - Faz parsing da base, valida colunas
   * - Filtra roles desconhecidos
   * - Insere em lab_transcripts_raw
   * - Inicializa lab_progress por motivo com denominadores (distinct IdAtendimento)
   */
  router.post('/scenarios/upload', requireCanManageScenarios(), upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado (campo: file)' });
      }

      await pgClient.query('BEGIN');

      // Cria run
      const runIns = await pgClient.query(
        `INSERT INTO public.lab_runs (client_id, created_by)
         VALUES ($1, $2)
         RETURNING id, status, created_at`,
        [req.clientId, req.user?.id || null]
      );
      const run = runIns.rows[0];
      const runId = run.id;

      // Parser
      let parsed;
      try {
        parsed = await parseTranscriptBase({ buffer: file.buffer, filename: file.originalname, mime: file.mimetype });
      } catch (e) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ error: String(e?.message || e) });
      }

      const allowedNorm = new Set(['operator', 'bot', 'customer']);
      const allowedRaw = new Set(['agent', 'bot', 'user']);

      // Filtra linhas com roles válidos
      const validRows = (parsed.rows || []).filter(
        (r) => allowedNorm.has(r.role_norm) && allowedRaw.has(r.role_raw)
      );

      const skippedRows = (parsed.rows || []).length - validRows.length;
      const warnings = Array.isArray(parsed.warnings) ? [...parsed.warnings] : [];
      if (skippedRows > 0) {
        warnings.push(`Foram ignoradas ${skippedRows} linhas devido a Role desconhecida ou inválida.`);
      }

      // Inserção das linhas normalizadas
      for (let i = 0; i < validRows.length; i++) {
        const r = validRows[i];
        await pgClient.query(
          `INSERT INTO public.lab_transcripts_raw
             (run_id, client_id, atendimento_id, motivo, seq, role_raw, role_norm, message_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [runId, req.clientId, r.atendimento_id, r.motivo, r.seq, r.role_raw, r.role_norm, r.message_text]
        );
      }

      // Recalcular stats com linhas válidas
      const stats = computeStatsFromRows(validRows);

      // Inicializa lab_progress por motivo (denominadores)
      for (const [motivo, total] of Object.entries(stats.motivoDistinctIds)) {
        await pgClient.query(
          `INSERT INTO public.lab_progress (run_id, client_id, motivo, total_ids_distinct, processed_ids_distinct)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (run_id, motivo) DO UPDATE
             SET total_ids_distinct = EXCLUDED.total_ids_distinct,
                 updated_at = now()`,
          [runId, req.clientId, motivo, total]
        );
      }

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'lab_runs',
        entityId: runId,
        action: 'upload_transcripts',
        before: null,
        after: {
          file_name: file.originalname || null,
          mime_type: file.mimetype || null,
          size_bytes: file.size || file.buffer?.length || null,
          rows_parsed: (parsed.rows || []).length,
          rows_valid: validRows.length,
          warnings_count: warnings.length,
        },
      });

      await pgClient.query('COMMIT');

      return res.json({
        ok: true,
        run_id: runId,
        status: run.status,
        totals: {
          totalDistinctIds: stats.totalDistinctIds,
          motivoDistinctIds: stats.motivoDistinctIds,
        },
        inserted_rows: validRows.length,
        skipped_rows: skippedRows,
        warnings,
      });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('Lab upload error:', err);
      return res.status(500).json({ error: 'Erro ao processar upload do laboratório' });
    }
  });

  /**
   * POST /api/lab/scenarios/analyze/:run_id
   * Dispara processamento assíncrono (LLM) agrupando por IdAtendimento.
   * Neste commit inicial, retorna Accepted (stub) até o job ser implementado.
   */
  router.post('/scenarios/analyze/:run_id', requireCanManageScenarios(), async (req, res) => {
    try {
      const { run_id } = req.params;
      // Verifica se o run pertence ao cliente
      const r = await pgClient.query(
        `SELECT id, status FROM public.lab_runs WHERE id = $1 AND client_id = $2`,
        [run_id, req.clientId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'Execução não encontrada neste cliente' });
      }

      // Marca como running (idempotente)
      await pgClient.query(
        `UPDATE public.lab_runs SET status = 'running', updated_at = now()
           WHERE id = $1 AND client_id = $2`,
        [run_id, req.clientId]
      );

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'lab_runs',
        entityId: String(run_id),
        action: 'start_analysis',
        before: { status: r.rows[0].status },
        after: { status: 'running' },
      });

      // Inicia job assíncrono
      await startLabAnalysis(pgClient, { runId: run_id, clientId: req.clientId });

      // Retorna 202 Accepted indicando que a análise foi agendada
      return res.status(202).json({ ok: true, started: true, run_id });
    } catch (err) {
      console.error('Lab analyze start error:', err);
      return res.status(500).json({ error: 'Erro ao iniciar análise' });
    }
  });

  /**
   * GET /api/lab/scenarios/progress/:run_id
   * Retorna progresso por motivo (numerador e denominador) e status do run.
   * Inclui indicação de cache por motivo (se existir em lab_motivos_cache para este cliente).
   */
  router.get('/scenarios/progress/:run_id', requireCanManageScenarios(), async (req, res) => {
    try {
      const { run_id } = req.params;

      // Status do run
      const rr = await pgClient.query(
        `SELECT id, status, created_at, updated_at
           FROM public.lab_runs
          WHERE id = $1 AND client_id = $2`,
        [run_id, req.clientId]
      );
      if (rr.rows.length === 0) {
        return res.status(404).json({ error: 'Execução não encontrada neste cliente' });
      }
      const run = rr.rows[0];

      const pr = await pgClient.query(
        `SELECT motivo, total_ids_distinct, processed_ids_distinct, updated_at
           FROM public.lab_progress
          WHERE run_id = $1
          ORDER BY motivo ASC`,
        [run_id]
      );
      const motivos = pr.rows;

      let totalDistinctIds = 0;
      let processedDistinctIds = 0;
      const motivoList = motivos.map((m) => m.motivo);
      for (const m of motivos) {
        totalDistinctIds += Number(m.total_ids_distinct || 0);
        processedDistinctIds += Number(m.processed_ids_distinct || 0);
      }

      // Cache por motivo (client-scoped)
      let cachedMotivos = [];
      if (motivoList.length > 0) {
        const c = await pgClient.query(
          `SELECT motivo, cached_at
             FROM public.lab_motivos_cache
            WHERE client_id = $1 AND motivo = ANY($2::text[])
            ORDER BY cached_at DESC`,
          [req.clientId, motivoList]
        );
        cachedMotivos = c.rows || [];
      }

      return res.json({
        run: { id: run.id, status: run.status, created_at: run.created_at, updated_at: run.updated_at },
        motivos: motivos.map((m) => ({
          motivo: m.motivo,
          total_ids_distinct: m.total_ids_distinct,
          processed_ids_distinct: m.processed_ids_distinct,
          updated_at: m.updated_at,
          cached: cachedMotivos.some((c) => c.motivo === m.motivo),
        })),
        overall: {
          totalDistinctIds,
          processedDistinctIds,
        },
      });
    } catch (err) {
      console.error('Lab progress error:', err);
      return res.status(500).json({ error: 'Erro ao carregar progresso' });
    }
  });

  /**
   * GET /api/lab/scenarios/results/:run_id
   * Lista resultados agregados por motivo (lab_results) para revisão.
   */
  router.get('/scenarios/results/:run_id', requireCanManageScenarios(), async (req, res) => {
    try {
      const { run_id } = req.params;
      // Confirma run do cliente
      const rr = await pgClient.query(
        `SELECT id FROM public.lab_runs WHERE id = $1 AND client_id = $2`,
        [run_id, req.clientId]
      );
      if (rr.rows.length === 0) {
        return res.status(404).json({ error: 'Execução não encontrada neste cliente' });
      }

      const r = await pgClient.query(
        `SELECT motivo, scenario_title, customer_profiles, process_text, operator_guidelines, patterns, status, updated_at
           FROM public.lab_results
          WHERE run_id = $1 AND client_id = $2
          ORDER BY motivo ASC`,
        [run_id, req.clientId]
      );

      return res.json({ run_id, results: r.rows });
    } catch (err) {
      console.error('Lab results error:', err);
      return res.status(500).json({ error: 'Erro ao carregar resultados' });
    }
  });

  /**
   * POST /api/lab/scenarios/commit
   * Body: { run_id, motivo }
   * - Valida existência de run e resultado pronto
   * - Upsert em scenarios + scenario_profiles
   * - Cria KB de processo em public.knowledge_base (se houver process_text)
   * - Cria KB Operador em kb_sources/kb_chunks com operator_guidelines (RAG)
   * - Auditoria
   */
  router.post('/scenarios/commit', requireCanManageScenarios(), async (req, res) => {
    try {
      const { run_id, motivo } = req.body || {};
      if (!run_id || !motivo) {
        return res.status(400).json({ error: 'run_id e motivo são obrigatórios' });
      }

      // Verifica se o run pertence ao cliente
      const rr = await pgClient.query(
        `SELECT id FROM public.lab_runs WHERE id = $1 AND client_id = $2`,
        [run_id, req.clientId]
      );
      if (rr.rows.length === 0) {
        return res.status(404).json({ error: 'Execução não encontrada neste cliente' });
      }

      // Carrega resultado agregado do motivo
      const resAgg = await pgClient.query(
        `SELECT motivo, scenario_title, customer_profiles, process_text, operator_guidelines, patterns, status
           FROM public.lab_results
          WHERE run_id = $1 AND client_id = $2 AND motivo = $3`,
        [run_id, req.clientId, motivo]
      );
      if (resAgg.rows.length === 0) {
        return res.status(404).json({ error: 'Resultado não encontrado para este motivo', code: 'RESULT_NOT_FOUND' });
      }
      const result = resAgg.rows[0];

      // Opcionalmente exigir status 'ready'
      if (String(result.status || '').toLowerCase() !== 'ready') {
        return res.status(409).json({ error: "Resultado ainda não está 'ready' para commit", code: 'RESULT_NOT_READY' });
      }

      const scenarioTitle = String(result.scenario_title || motivo).trim() || String(motivo);
      const profiles = Array.isArray(result.customer_profiles) ? result.customer_profiles : [];
      const processText = typeof result.process_text === 'string' ? result.process_text : null;
      const operatorGuidelines = Array.isArray(result.operator_guidelines) ? result.operator_guidelines : [];
      const patterns = Array.isArray(result.patterns) ? result.patterns : [];

      // Preparos para KB Operador (RAG)
      const embedder = createAzureEmbedder();

      await pgClient.query('BEGIN');

      // Upsert em scenarios
      const metadata = {
        run_id,
        motivo,
        patterns,
      };
      const sUp = await pgClient.query(
        `INSERT INTO public.scenarios (client_id, motivo_label, title, metadata, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (client_id, motivo_label) DO UPDATE
           SET title = EXCLUDED.title,
               metadata = EXCLUDED.metadata,
               updated_at = now()
         RETURNING id`,
        [req.clientId, motivo, scenarioTitle, JSON.stringify(metadata), req.user?.id || null]
      );
      const scenarioId = sUp.rows[0].id;

      // Perfis
      for (const p of profiles) {
        const label = String(p || '').trim();
        if (!label) continue;
        await pgClient.query(
          `INSERT INTO public.scenario_profiles (scenario_id, profile_label)
           VALUES ($1, $2)
           ON CONFLICT (scenario_id, profile_label) DO NOTHING`,
          [scenarioId, label]
        );
      }

      // Knowledge Base (processo) - opcional
      let processKbId = null;
      if (processText && processText.trim().length > 0) {
        const title = `Processo - ${scenarioTitle}`;
        const category = 'processo';
        const rKB = await pgClient.query(
          `INSERT INTO public.knowledge_base (title, category, content, client_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [title, category, processText, req.clientId]
        );
        processKbId = rKB.rows[0].id;
      }

      // KB Operador (RAG) com operator_guidelines - opcional
      let kbSourceOperatorId = null;
      if (operatorGuidelines.length > 0) {
        // Texto consolidado
        const text = normalizeText(operatorGuidelines.map((g, idx) => `- (${idx + 1}) ${String(g || '').trim()}`).join('\n'));
        // Chunking
        const chunks = chunkText(text, {
          chunkTokens: Number(process.env.RAG_CHUNK_TOKENS || 800),
          overlapTokens: Number(process.env.RAG_CHUNK_OVERLAP || 200),
        });
        // Embeddings
        const embeddings = await embedder.embed(chunks.map((c) => c.content));

        // Cria fonte free_text em kb_sources (kb_type='operador')
        const srcIns = await pgClient.query(
          `INSERT INTO public.kb_sources (client_id, kb_type, source_kind, title, status, created_by)
           VALUES ($1, $2, 'free_text', $3, 'active', $4)
           RETURNING id`,
          [req.clientId, 'operador', `Diretrizes - ${scenarioTitle}`, req.user?.id || null]
        );
        kbSourceOperatorId = srcIns.rows[0].id;

        // Inserir chunks
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

      // Auditoria
      await writeAudit(pgClient, req, {
        entityType: 'scenarios',
        entityId: scenarioId,
        action: 'commit_from_lab',
        before: null,
        after: {
          scenario_id: scenarioId,
          motivo,
          scenario_title: scenarioTitle,
          profiles,
          process_kb_id: processKbId,
          kb_source_operator_id: kbSourceOperatorId,
          patterns_count: patterns.length,
        },
      });

      await pgClient.query('COMMIT');

      return res.json({
        ok: true,
        scenario_id: scenarioId,
        process_kb_id: processKbId,
        kb_source_operator_id: kbSourceOperatorId,
      });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('Lab commit error:', err);
      return res.status(500).json({ error: 'Erro ao commitar cenário' });
    }
  });

  return router;
}

export default { labRoutes };