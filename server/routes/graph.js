import express from 'express';
import { anonymizePII } from '../services/ingestion.js';
import { requireCanEditKB } from '../middleware/permissions.js';
import { runGraphExtractionForClient } from '../jobs/graph_extraction.js';

/**
 * Rotas de Graph RAG por cliente
 *
 * Prefixo de montagem em server/index.js:
 *   app.use('/api/kb/graph', requireAuth(pgClient), requireTenant(pgClient), graphRoutes(pgClient))
 *
 * Permissões:
 * - Visualização (GET): qualquer usuário autenticado do cliente (somente requireAuth + requireTenant no prefixo)
 * - Extração (POST /extract): requireCanEditKB()
 *
 * Endpoints:
 * - GET /api/kb/graph            -> Lista nós e arestas (opcional filtro kb_type)
 * - GET /api/kb/graph/neighbors  -> Vizinhança de um nó específico
 * - GET /api/kb/graph/projections -> Projeções 2D (ex.: PCA) dos chunks (opcional filtro kb_type)
 * - POST /api/kb/graph/extract   -> Executa job de extração de nós/arestas via LLM
 */

/**
 * Normaliza kb_type.
 */
function normalizeKbType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'cliente' || t === 'operador') return t;
  return null;
}

/**
 * Aplica anonimização de PII em strings e dentro de objetos/arrays.
 */
function anonymizeRecursive(value, mode) {
  if (mode === 'raw') return value;
  if (value == null) return value;
  if (typeof value === 'string') {
    return anonymizePII(value, 'default');
  }
  if (Array.isArray(value)) {
    return value.map((v) => anonymizeRecursive(v, mode));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = anonymizeRecursive(v, mode);
    }
    return out;
  }
  return value;
}

export function graphRoutes(pgClient) {
  const router = express.Router();

  /**
   * GET /api/kb/graph
   * Query:
   *  - kb_type: 'cliente'|'operador' (opcional)
   *  - limit_nodes: número máximo de nós (default 1000)
   *  - limit_edges: número máximo de arestas (default 2000)
   *  - pii_mode: 'default' (anonimiza) | 'raw' (não anonimiza)
   */
  router.get('/', async (req, res) => {
    try {
      const kbType = normalizeKbType(req.query?.kb_type);
      const limitNodes = Number.isFinite(Number(req.query?.limit_nodes)) ? Math.max(1, Number(req.query.limit_nodes)) : 1000;
      const limitEdges = Number.isFinite(Number(req.query?.limit_edges)) ? Math.max(1, Number(req.query.limit_edges)) : 2000;
      const piiMode = String(req.query?.pii_mode || 'default').trim().toLowerCase() === 'raw' ? 'raw' : 'default';
      const sourceIdRaw = String(req.query?.source_id || '').trim();
      const sourceId = sourceIdRaw.length > 0 ? sourceIdRaw : null;

      // Nós (opcional filtro por source_id)
      let sqlN = `SELECT id, label, node_type, source_id, kb_type, properties
                    FROM public.kb_nodes
                   WHERE client_id = $1`;
      const paramsN = [req.clientId];
      if (kbType) {
        sqlN += ' AND kb_type = $2';
        paramsN.push(kbType);
      }
      if (sourceId) {
        sqlN += ' AND source_id = $' + (paramsN.length + 1);
        paramsN.push(sourceId);
      }
      sqlN += ' ORDER BY id ASC LIMIT $' + (paramsN.length + 1);
      paramsN.push(limitNodes);

      const nodesRes = await pgClient.query(sqlN, paramsN);
      const nodes = (nodesRes.rows || []).map((n) => ({
        ...n,
        label: typeof n.label === 'string' ? anonymizeRecursive(n.label, piiMode) : n.label,
        properties: anonymizeRecursive(n.properties, piiMode),
      }));

      // Arestas
      let edgesRes, edges = [];
      if (sourceId) {
        // Restringir arestas ao subgrafo da fonte: ambos os nós pertencem ao source_id
        let sqlE = `SELECT e.id, e.src_node_id, e.dst_node_id, e.relation, e.kb_type, e.properties
                      FROM public.kb_edges e
                      JOIN public.kb_nodes sn ON sn.id = e.src_node_id
                      JOIN public.kb_nodes dn ON dn.id = e.dst_node_id
                     WHERE e.client_id = $1 AND sn.client_id = $1 AND dn.client_id = $1`;
        const paramsE = [req.clientId];
        if (kbType) {
          sqlE += ' AND e.kb_type = $2';
          paramsE.push(kbType);
        }
        sqlE += ' AND sn.source_id = $' + (paramsE.length + 1);
        paramsE.push(sourceId);
        sqlE += ' AND dn.source_id = $' + (paramsE.length + 1);
        paramsE.push(sourceId);
        sqlE += ' ORDER BY e.id ASC LIMIT $' + (paramsE.length + 1);
        paramsE.push(limitEdges);

        edgesRes = await pgClient.query(sqlE, paramsE);
        edges = (edgesRes.rows || []).map((e) => ({
          ...e,
          properties: anonymizeRecursive(e.properties, piiMode),
        }));
      } else {
        let sqlE = `SELECT id, src_node_id, dst_node_id, relation, kb_type, properties
                      FROM public.kb_edges
                     WHERE client_id = $1`;
        const paramsE = [req.clientId];
        if (kbType) {
          sqlE += ' AND kb_type = $2';
          paramsE.push(kbType);
        }
        sqlE += ' ORDER BY id ASC LIMIT $' + (paramsE.length + 1);
        paramsE.push(limitEdges);

        edgesRes = await pgClient.query(sqlE, paramsE);
        edges = (edgesRes.rows || []).map((e) => ({
          ...e,
          properties: anonymizeRecursive(e.properties, piiMode),
        }));
      }

      return res.json({ nodes, edges, kb_type: kbType, counts: { nodes: nodes.length, edges: edges.length } });
    } catch (err) {
      console.error('Graph list error:', err);
      return res.status(500).json({ error: 'Erro ao carregar grafo' });
    }
  });

  /**
   * GET /api/kb/graph/neighbors
   * Query:
   *  - node_id: ID do nó (obrigatório)
   *  - kb_type: 'cliente'|'operador' (opcional)
   *  - limit: máximo de arestas a retornar (default 500)
   *  - pii_mode: 'default'|'raw'
   */
  router.get('/neighbors', async (req, res) => {
    try {
      const nodeIdRaw = String(req.query?.node_id || '').trim();
      if (!nodeIdRaw) {
        return res.status(400).json({ error: 'node_id inválido ou ausente' });
      }
      // Detecta tipo do ID (UUID vs inteiro)
      const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      const idIsUUID = uuidRegex.test(nodeIdRaw);
      const nodeIdNum = Number(nodeIdRaw);
      const idIsNumeric = Number.isFinite(nodeIdNum) && nodeIdNum > 0;
      if (!idIsUUID && !idIsNumeric) {
        return res.status(400).json({ error: 'node_id inválido (esperado UUID ou inteiro positivo)' });
      }

      const kbType = normalizeKbType(req.query?.kb_type);
      const limit = Number.isFinite(Number(req.query?.limit)) ? Math.max(1, Number(req.query.limit)) : 500;
      const piiMode = String(req.query?.pii_mode || 'default').trim().toLowerCase() === 'raw' ? 'raw' : 'default';
      const sourceIdRaw = String(req.query?.source_id || '').trim();
      const sourceId = sourceIdRaw.length > 0 ? sourceIdRaw : null;

      let edgesRes, edges = [];
      if (sourceId) {
        // Restringir vizinhança ao subgrafo da fonte
        let sqlEdges = `SELECT e.id, e.src_node_id, e.dst_node_id, e.relation, e.kb_type, e.properties
                          FROM public.kb_edges e
                          JOIN public.kb_nodes sn ON sn.id = e.src_node_id
                          JOIN public.kb_nodes dn ON dn.id = e.dst_node_id
                         WHERE e.client_id = $1 AND sn.client_id = $1 AND dn.client_id = $1`;
        const params = [req.clientId];

        if (kbType) {
          sqlEdges += ' AND e.kb_type = $' + (params.length + 1);
          params.push(kbType);
        }

        // Match central node (UUID ou inteiro)
        if (idIsUUID) {
          sqlEdges += ' AND (e.src_node_id = $' + (params.length + 1) + '::uuid OR e.dst_node_id = $' + (params.length + 1) + '::uuid)';
          params.push(nodeIdRaw);
        } else {
          sqlEdges += ' AND (e.src_node_id = $' + (params.length + 1) + ' OR e.dst_node_id = $' + (params.length + 1) + ')';
          params.push(nodeIdNum);
        }

        // Restringe ambos os nós à mesma fonte
        sqlEdges += ' AND sn.source_id = $' + (params.length + 1);
        params.push(sourceId);
        sqlEdges += ' AND dn.source_id = $' + (params.length + 1);
        params.push(sourceId);

        sqlEdges += ' ORDER BY e.id ASC LIMIT $' + (params.length + 1);
        params.push(limit);

        edgesRes = await pgClient.query(sqlEdges, params);
        edges = (edgesRes.rows || []).map((e) => ({
          ...e,
          properties: anonymizeRecursive(e.properties, piiMode),
        }));
      } else {
        // Vizinhança no grafo geral do cliente
        let sqlEdges = `SELECT id, src_node_id, dst_node_id, relation, kb_type, properties
                          FROM public.kb_edges
                         WHERE client_id = $1`;
        const params = [req.clientId];

        if (kbType) {
          sqlEdges += ' AND kb_type = $' + (params.length + 1);
          params.push(kbType);
        }

        if (idIsUUID) {
          sqlEdges += ' AND (src_node_id = $' + (params.length + 1) + '::uuid OR dst_node_id = $' + (params.length + 1) + '::uuid)';
          params.push(nodeIdRaw);
        } else {
          sqlEdges += ' AND (src_node_id = $' + (params.length + 1) + ' OR dst_node_id = $' + (params.length + 1) + ')';
          params.push(nodeIdNum);
        }

        sqlEdges += ' ORDER BY id ASC LIMIT $' + (params.length + 1);
        params.push(limit);

        edgesRes = await pgClient.query(sqlEdges, params);
        edges = (edgesRes.rows || []).map((e) => ({
          ...e,
          properties: anonymizeRecursive(e.properties, piiMode),
        }));
      }

      // Conjunto de IDs (como strings) para carregar nós vizinhos
      const neighborIdsSet = new Set([idIsUUID ? nodeIdRaw : String(nodeIdNum)]);
      edges.forEach((e) => {
        neighborIdsSet.add(String(e.src_node_id));
        neighborIdsSet.add(String(e.dst_node_id));
      });
      const neighborIds = Array.from(neighborIdsSet.values());

      // Carregar nós vizinhos (opcional filtro source_id)
      let sqlNodes = `SELECT id, label, node_type, source_id, kb_type, properties
                        FROM public.kb_nodes
                       WHERE client_id = $1 AND id = ANY($2::${idIsUUID ? 'uuid' : 'bigint'}[])`;
      const paramsN = [req.clientId, neighborIds];

      if (kbType) {
        sqlNodes += ' AND kb_type = $' + (paramsN.length + 1);
        paramsN.push(kbType);
      }
      if (sourceId) {
        sqlNodes += ' AND source_id = $' + (paramsN.length + 1);
        paramsN.push(sourceId);
      }

      const nodesRes = await pgClient.query(sqlNodes, paramsN);
      const nodes = (nodesRes.rows || []).map((n) => ({
        ...n,
        label: typeof n.label === 'string' ? anonymizeRecursive(n.label, piiMode) : n.label,
        properties: anonymizeRecursive(n.properties, piiMode),
      }));

      return res.json({ center_node_id: idIsUUID ? nodeIdRaw : nodeIdNum, nodes, edges, kb_type: kbType, source_id: sourceId || null });
    } catch (err) {
      console.error('Graph neighbors error:', err);
      return res.status(500).json({ error: 'Erro ao carregar vizinhança' });
    }
  });

  /**
   * GET /api/kb/graph/export
   * Query:
   *  - source_id: UUID da fonte (obrigatório)
   *  - kb_type: 'cliente'|'operador' (opcional)
   *  - pii_mode: 'default'|'raw' (default: 'default')
   * Retorna JSON com nós/arestas da fonte.
   */
  router.get('/export', async (req, res) => {
    try {
      const kbType = normalizeKbType(req.query?.kb_type);
      const piiMode = String(req.query?.pii_mode || 'default').trim().toLowerCase() === 'raw' ? 'raw' : 'default';
      const sourceId = String(req.query?.source_id || '').trim();
      if (!sourceId) {
        return res.status(400).json({ error: 'source_id é obrigatório' });
      }

      // Nós da fonte
      let sqlN = `SELECT id, label, node_type, source_id, kb_type, properties
                    FROM public.kb_nodes
                   WHERE client_id = $1 AND source_id = $2`;
      const paramsN = [req.clientId, sourceId];
      if (kbType) {
        sqlN += ' AND kb_type = $3';
        paramsN.push(kbType);
      }
      const nodesRes = await pgClient.query(sqlN, paramsN);
      const nodes = (nodesRes.rows || []).map((n) => ({
        ...n,
        label: typeof n.label === 'string' ? anonymizeRecursive(n.label, piiMode) : n.label,
        properties: anonymizeRecursive(n.properties, piiMode),
      }));

      // Arestas da fonte (ambos os nós pertencem à mesma source_id)
      let sqlE = `SELECT e.id, e.src_node_id, e.dst_node_id, e.relation, e.kb_type, e.properties
                    FROM public.kb_edges e
                    JOIN public.kb_nodes sn ON sn.id = e.src_node_id
                    JOIN public.kb_nodes dn ON dn.id = e.dst_node_id
                   WHERE e.client_id = $1 AND sn.client_id = $1 AND dn.client_id = $1
                     AND sn.source_id = $2 AND dn.source_id = $2`;
      const paramsE = [req.clientId, sourceId];
      if (kbType) {
        sqlE += ' AND e.kb_type = $3';
        paramsE.push(kbType);
      }
      const edgesRes = await pgClient.query(sqlE, paramsE);
      const edges = (edgesRes.rows || []).map((e) => ({
        ...e,
        properties: anonymizeRecursive(e.properties, piiMode),
      }));

      return res.json({ nodes, edges, counts: { nodes: nodes.length, edges: edges.length }, kb_type: kbType, source_id: sourceId });
    } catch (err) {
      console.error('Graph export error:', err);
      return res.status(500).json({ error: 'Erro ao exportar grafo da fonte' });
    }
  });

  /**
   * GET /api/kb/graph/projections
   * Query:
   *  - algo: 'pca' (default) | outros futuros
   *  - kb_type: 'cliente'|'operador' (opcional)
   *  - limit: máximo de pontos (default 2000)
   *  - pii_mode: 'default'|'raw'
   *
   * Retorna pontos 2D com metadados mínimos dos chunks.
   */
  router.get('/projections', async (req, res) => {
    try {
      const algo = String(req.query?.algo || 'pca').trim().toLowerCase();
      const kbType = normalizeKbType(req.query?.kb_type);
      const limit = Number.isFinite(Number(req.query?.limit)) ? Math.max(1, Number(req.query.limit)) : 2000;
      const piiMode = String(req.query?.pii_mode || 'default').trim().toLowerCase() === 'raw' ? 'raw' : 'default';

      let sql = `SELECT p.chunk_id, p.x, p.y, p.algo,
                        kc.kb_type, kc.content, kc.source_id, ks.title AS source_title
                   FROM public.kb_chunk_projections p
                   JOIN public.kb_chunks kc ON kc.id = p.chunk_id
                   JOIN public.kb_sources ks ON ks.id = kc.source_id
                  WHERE kc.client_id = $1 AND p.algo = $2`;
      const params = [req.clientId, algo];
      if (kbType) {
        sql += ' AND kc.kb_type = $3';
        params.push(kbType);
      }
      sql += ' ORDER BY p.chunk_id ASC LIMIT $' + (params.length + 1);
      params.push(limit);

      const r = await pgClient.query(sql, params);
      const points = (r.rows || []).map((row) => {
        const safeContent = typeof row.content === 'string' ? anonymizeRecursive(row.content, piiMode) : row.content;
        return {
          chunk_id: row.chunk_id,
          x: row.x,
          y: row.y,
          algo: row.algo,
          kb_type: row.kb_type,
          source_id: row.source_id,
          source_title: anonymizeRecursive(row.source_title, piiMode),
          // Conteúdo resumido para tooltip (primeiros 300 chars)
          content_snippet: typeof safeContent === 'string' ? safeContent.slice(0, 300) : '',
        };
      });

      return res.json({ algo, kb_type: kbType, points, count: points.length });
    } catch (err) {
      console.error('Graph projections error:', err);
      return res.status(500).json({ error: 'Erro ao carregar projeções' });
    }
  });

  /**
   * POST /api/kb/graph/extract
   * Body:
   *  - kb_type: 'cliente'|'operador' (obrigatório)
   *  - limit_chunks: número máximo de chunks a processar (default 200)
   *  - pii_mode: 'default' (anonimiza ao enviar ao LLM) | 'raw' (envia texto original)
   *
   * Executa o job de extração de grafo para o cliente atual.
   */
  router.post('/extract', requireCanEditKB(), async (req, res) => {
    try {
      const kbType = normalizeKbType(req.body?.kb_type);
      if (!kbType) {
        return res.status(400).json({ error: 'kb_type inválido', allowed: ['cliente', 'operador'] });
      }
      const limitChunks = Number.isFinite(Number(req.body?.limit_chunks)) ? Math.max(1, Number(req.body.limit_chunks)) : 200;
      const piiMode = String(req.body?.pii_mode || 'default').trim().toLowerCase() === 'raw' ? 'raw' : 'default';
      const sourceId = typeof req.body?.source_id === 'string' ? req.body.source_id.trim() : null;

      const result = await runGraphExtractionForClient(pgClient, {
        clientId: req.clientId,
        kbType,
        limitChunks,
        piiMode,
        sourceId: sourceId && sourceId.length > 0 ? sourceId : null,
      });

      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = err && Number.isFinite(Number(err.status)) ? Number(err.status) : 500;
      const details = err?.details || err?.message || null;
      console.error('Graph extraction job error:', err);
      return res.status(status).json({ error: 'Erro ao extrair grafo', details });
    }
  });

  return router;
}

export default { graphRoutes };