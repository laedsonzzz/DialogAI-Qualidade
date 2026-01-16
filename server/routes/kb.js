import express from 'express';
import multer from 'multer';
import { writeAudit } from '../middleware/audit.js';
import { requireCanEditKB, requireAny } from '../middleware/permissions.js';
import { extractTextFromFile, anonymizePII, normalizeText } from '../services/ingestion.js';
import { chunkText } from '../services/chunker.js';
import { createAzureEmbedder } from '../services/embeddings.js';

/**
 * Rotas de Knowledge Base (RAG) por cliente
 *
 * Prefixo de montagem em server/index.js:
 *   app.use('/api/kb', requireAuth(pgClient), requireTenant(pgClient), kbRoutes(pgClient))
 *
 * Permissões:
 * - Upload/Text/Archive/Delete: requireCanEditKB()
 * - Search: qualquer usuário autenticado no cliente (apenas requireAuth + requireTenant no prefixo)
 */

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: Math.max(1, Number(process.env.UPLOAD_MAX_MB || 10)) * 1024 * 1024, // por arquivo
  },
});

function toVectorLiteral(arr) {
  // pgvector aceita formato: '[0.1,0.2,...]'
  if (!Array.isArray(arr)) return '[]';
  return `[${arr.map((x) => (typeof x === 'number' ? x : Number(x) || 0)).join(',')}]`;
}

export function kbRoutes(pgClient) {
  const router = express.Router();
  const embedder = createAzureEmbedder();

  /**
   * POST /api/kb/sources/upload
   * Multipart: files[]; fields: kb_type ('cliente'|'operador'), pii_mode? ('default'|'raw'), title? (opcional, usado se 1 arquivo)
   * - Extrai texto por arquivo
   * - Normaliza e anonimiza PII por padrão (flag para 'raw' se necessário)
   * - Chunking com overlap conforme env
   * - Embeddings Azure
   * - Persistência em kb_sources/kb_chunks
   */
  router.post('/sources/upload', requireCanEditKB(), upload.array('files', 20), async (req, res) => {
    try {
      const kbType = String(req.body?.kb_type || '').trim().toLowerCase();
      const piiMode = String(req.body?.pii_mode || 'default').trim().toLowerCase();
      const titleSingle = typeof req.body?.title === 'string' ? req.body.title.trim() : null;

      if (!['cliente', 'operador'].includes(kbType)) {
        return res.status(400).json({ error: 'kb_type inválido', allowed: ['cliente', 'operador'] });
      }
      const files = req.files || [];
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado (use campo files[])' });
      }

      const results = [];
      await pgClient.query('BEGIN');

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const textRaw = await extractTextFromFile({ buffer: f.buffer, filename: f.originalname, mime: f.mimetype });
        const textNorm = normalizeText(textRaw);
        const text = anonymizePII(textNorm, piiMode === 'raw' ? 'raw' : 'default');

        const chunks = chunkText(text, {
          chunkTokens: Number(process.env.RAG_CHUNK_TOKENS || 800),
          overlapTokens: Number(process.env.RAG_CHUNK_OVERLAP || 200),
        });

        // Embeddings por chunk
        const embeddings = await embedder.embed(chunks.map((c) => c.content));

        // Criar fonte
        const sourceTitle = files.length === 1 && titleSingle ? titleSingle : (f.originalname || 'Documento');
        const sIns = await pgClient.query(
          `INSERT INTO public.kb_sources (client_id, kb_type, source_kind, title, original_filename, mime_type, size_bytes, status, created_by)
           VALUES ($1, $2, 'document', $3, $4, $5, $6, 'active', $7)
           RETURNING id`,
          [req.clientId, kbType, sourceTitle, f.originalname || null, f.mimetype || null, f.size || f.buffer?.length || null, req.user?.id || null]
        );
        const sourceId = sIns.rows[0].id;

        // Inserir chunks
        for (let j = 0; j < chunks.length; j++) {
          const vec = toVectorLiteral(embeddings[j] || []);
          const c = chunks[j];
          await pgClient.query(
            `INSERT INTO public.kb_chunks (source_id, client_id, kb_type, chunk_no, content, tokens, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [sourceId, req.clientId, kbType, j + 1, c.content, c.tokens || null, vec]
          );
        }

        // Auditoria por fonte
        await writeAudit(pgClient, req, {
          entityType: 'kb_sources',
          entityId: sourceId,
          action: 'create_document_source',
          before: null,
          after: { id: sourceId, kb_type: kbType, title: sourceTitle, original_filename: f.originalname, mime_type: f.mimetype },
        });

        results.push({ id: sourceId, title: sourceTitle, chunks: chunks.length });
      }

      await pgClient.query('COMMIT');
      return res.json({ ok: true, created: results });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('KB upload error:', err);
      const status = err.status || 500;
      return res.status(status).json({ error: err.message || 'Erro ao subir documentos' });
    }
  });

  /**
   * POST /api/kb/sources/text
   * Body: { kb_type: 'cliente'|'operador', title, content, pii_mode? }
   * - Cria fonte de texto livre e chunks+embeddings
   */
  router.post('/sources/text', requireCanEditKB(), async (req, res) => {
    try {
      const kbType = String(req.body?.kb_type || '').trim().toLowerCase();
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const piiMode = String(req.body?.pii_mode || 'default').trim().toLowerCase();

      if (!['cliente', 'operador'].includes(kbType)) {
        return res.status(400).json({ error: 'kb_type inválido', allowed: ['cliente', 'operador'] });
      }
      if (!title) {
        return res.status(400).json({ error: 'title é obrigatório' });
      }
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'content é obrigatório' });
      }

      const textNorm = normalizeText(content);
      const text = anonymizePII(textNorm, piiMode === 'raw' ? 'raw' : 'default');
      const chunks = chunkText(text, {
        chunkTokens: Number(process.env.RAG_CHUNK_TOKENS || 800),
        overlapTokens: Number(process.env.RAG_CHUNK_OVERLAP || 200),
      });
      const embeddings = await embedder.embed(chunks.map((c) => c.content));

      await pgClient.query('BEGIN');

      const sIns = await pgClient.query(
        `INSERT INTO public.kb_sources (client_id, kb_type, source_kind, title, status, created_by)
         VALUES ($1, $2, 'free_text', $3, 'active', $4)
         RETURNING id`,
        [req.clientId, kbType, title, req.user?.id || null]
      );
      const sourceId = sIns.rows[0].id;

      for (let j = 0; j < chunks.length; j++) {
        const vec = toVectorLiteral(embeddings[j] || []);
        const c = chunks[j];
        await pgClient.query(
          `INSERT INTO public.kb_chunks (source_id, client_id, kb_type, chunk_no, content, tokens, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [sourceId, req.clientId, kbType, j + 1, c.content, c.tokens || null, vec]
        );
      }

      await writeAudit(pgClient, req, {
        entityType: 'kb_sources',
        entityId: sourceId,
        action: 'create_free_text_source',
        before: null,
        after: { id: sourceId, kb_type: kbType, title },
      });

      await pgClient.query('COMMIT');
      return res.json({ ok: true, id: sourceId, title, chunks: chunks.length });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      console.error('KB text source error:', err);
      const status = err.status || 500;
      return res.status(status).json({ error: err.message || 'Erro ao criar fonte de texto' });
    }
  });

  /**
   * GET /api/kb/sources?kb_type=[cliente|operador]&status=[active|archived|all]
   */
  router.get('/sources', async (req, res) => {
    try {
      const kbType = String(req.query?.kb_type || '').trim().toLowerCase();
      const statusParam = String(req.query?.status || 'active').trim().toLowerCase();

      let sql = `SELECT id, kb_type, source_kind, title, original_filename, mime_type, size_bytes, status, created_by, created_at, updated_at
                   FROM public.kb_sources
                  WHERE client_id = $1`;
      const params = [req.clientId];

      if (['cliente', 'operador'].includes(kbType)) {
        sql += ' AND kb_type = $2';
        params.push(kbType);
      }
      if (statusParam === 'active' || statusParam === 'archived') {
        sql += (params.length === 1 ? ' AND status = $2' : ' AND status = $3');
        params.push(statusParam);
      }
      sql += ' ORDER BY created_at DESC';

      const r = await pgClient.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('KB sources list error:', err);
      return res.status(500).json({ error: 'Erro ao listar fontes' });
    }
  });

  /**
   * GET /api/kb/sources/:id/content
   * - Visualiza conteúdo agregado de uma fonte de texto livre (free_text)
   * - Concatena os conteúdos de kb_chunks em ordem de chunk_no
   * - Qualquer usuário autenticado no cliente pode visualizar (prefixo já aplica requireAuth+requireTenant)
   */
  router.get('/sources/:id/content', async (req, res) => {
    try {
      const { id } = req.params;

      // Carregar fonte do cliente
      const prev = await pgClient.query(
        `SELECT id, kb_type, source_kind, title, status
           FROM public.kb_sources
          WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Fonte não encontrada neste cliente' });
      }
      const source = prev.rows[0];

      if (String(source.source_kind) !== 'free_text') {
        return res.status(400).json({ error: 'Visualização disponível apenas para fontes de texto livre (free_text)', code: 'ONLY_FREE_TEXT' });
      }

      // Agregar conteúdo por chunks (em ordem)
      const cr = await pgClient.query(
        `SELECT chunk_no, content
           FROM public.kb_chunks
          WHERE source_id = $1 AND client_id = $2
          ORDER BY chunk_no ASC`,
        [id, req.clientId]
      );
      const parts = (cr.rows || []).map((r) => (typeof r.content === 'string' ? r.content : ''));

      return res.json({
        id: source.id,
        kb_type: source.kb_type,
        source_kind: source.source_kind,
        title: source.title,
        status: source.status,
        chunks: cr.rows.length,
        content: parts.join('\n\n'),
      });
    } catch (err) {
      console.error('KB source content view error:', err);
      return res.status(500).json({ error: 'Erro ao visualizar conteúdo da fonte' });
    }
  });

  /**
   * PATCH /api/kb/sources/:id
   * Body: { status: 'active'|'archived' }
   */
  router.patch('/sources/:id', requireCanEditKB(), async (req, res) => {
    try {
      const { id } = req.params;
      const normalized = String(req.body?.status || '').toLowerCase();
      if (!['active', 'archived'].includes(normalized)) {
        return res.status(400).json({ error: 'Status inválido', allowed: ['active', 'archived'] });
      }

      // Load previous state
      const prev = await pgClient.query(
        `SELECT id, kb_type, source_kind, title, status FROM public.kb_sources WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Fonte não encontrada neste cliente' });
      }
      const before = prev.rows[0];

      const upd = await pgClient.query(
        `UPDATE public.kb_sources SET status = $3 WHERE id = $1 AND client_id = $2`,
        [id, req.clientId, normalized]
      );
      if (upd.rowCount === 0) {
        return res.status(404).json({ error: 'Fonte não encontrada neste cliente' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'kb_sources',
        entityId: id,
        action: 'update_status',
        before,
        after: { ...before, status: normalized },
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('KB source status update error:', err);
      return res.status(500).json({ error: 'Erro ao atualizar status da fonte' });
    }
  });

  /**
   * DELETE /api/kb/sources/:id
   * - Exclui fonte; chunks serão removidos por cascata
   */
  router.delete('/sources/:id', requireCanEditKB(), async (req, res) => {
    try {
      const { id } = req.params;

      const prev = await pgClient.query(
        `SELECT id, kb_type, source_kind, title, status FROM public.kb_sources WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (prev.rows.length === 0) {
        return res.status(404).json({ error: 'Fonte não encontrada neste cliente' });
      }
      const before = prev.rows[0];

      const del = await pgClient.query(
        `DELETE FROM public.kb_sources WHERE id = $1 AND client_id = $2`,
        [id, req.clientId]
      );
      if (del.rowCount === 0) {
        return res.status(404).json({ error: 'Fonte não encontrada neste cliente' });
      }

      await writeAudit(pgClient, req, {
        entityType: 'kb_sources',
        entityId: id,
        action: 'delete_source',
        before,
        after: null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('KB source delete error:', err);
      return res.status(500).json({ error: 'Erro ao excluir fonte' });
    }
  });

  /**
   * POST /api/kb/search
   * Body: { query, kb_type?, topK? }
   * - Embedding da consulta via Azure
   * - Busca vetorial em kb_chunks (cosine) por client_id e kb_type opcional
   */
  router.post('/search', async (req, res) => {
    try {
      const queryText = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const kbType = String(req.body?.kb_type || '').trim().toLowerCase();
      const topK = Number.isFinite(Number(req.body?.topK)) ? Math.max(1, Number(req.body.topK)) : Math.max(1, Number(process.env.RAG_TOP_K || 8));

      if (!queryText) {
        return res.status(400).json({ error: 'query é obrigatório' });
      }

      const [queryVec] = await embedder.embed([queryText]);
      const vecLit = toVectorLiteral(queryVec);

      let sql = `SELECT kc.id, kc.source_id, kc.chunk_no, kc.content, kc.tokens,
                        ks.title AS source_title, ks.kb_type, ks.source_kind,
                        (kc.embedding <=> $1::vector) AS score
                   FROM public.kb_chunks kc
                   JOIN public.kb_sources ks ON ks.id = kc.source_id
                  WHERE kc.client_id = $2`;
      const params = [vecLit, req.clientId];

      if (['cliente', 'operador'].includes(kbType)) {
        sql += ' AND kc.kb_type = $3';
        params.push(kbType);
      }

      sql += ' ORDER BY kc.embedding <=> $1::vector ASC LIMIT $4';
      params.push(topK);

      const r = await pgClient.query(sql, params);
      return res.json({ results: r.rows, topK });
    } catch (err) {
      console.error('KB search error:', err);
      const status = err.status || 500;
      return res.status(status).json({ error: err.message || 'Erro na busca vetorial' });
    }
  });

  return router;
}

export default { kbRoutes };