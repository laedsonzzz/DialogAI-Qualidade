import { ProxyAgent, fetch } from 'undici';
import { anonymizePII } from '../services/ingestion.js';

/**
 * Job de extração de Grafo (Graph RAG) por cliente e tipo (cliente|operador).
 *
 * Funcionalidade:
 * - Percorre chunks da KB (por client_id e kb_type)
 * - Para cada chunk, chama LLM (Azure) para extrair nós e arestas
 * - Faz upsert de nós (deduplicando por label dentro do escopo client_id+kb_type)
 * - Cria arestas relacionando nós. De-duplicação é garantida por UNIQUE (client_id,kb_type,src_node_id,dst_node_id,relation)
 *
 * PII:
 * - Por padrão (piiMode='default'), o texto enviado ao LLM será anonimizado para reduzir vazamentos; persistimos os rótulos retornados pelo LLM (que podem estar anonimizados).
 * - Caso piiMode='raw', enviamos o texto original dos chunks.
 *
 * Uso recomendado:
 *   await runGraphExtractionForClient(pgClient, { clientId, kbType: 'cliente', limitChunks: 200, piiMode: 'default' });
 */

// Azure OpenAI env (canônicas com fallback para *_1)
const AZURE_OPENAI_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ||
  process.env.AZURE_OPENAI_ENDPOINT_1;

const AZURE_OPENAI_API_KEY =
  process.env.AZURE_OPENAI_API_KEY ||
  process.env.AZURE_OPENAI_API_KEY_1;

const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ||
  process.env.AZURE_OPENAI_API_VERSION_1;

// Deployment para chat/responses (modelo de texto)
const AZURE_OPENAI_DEPLOYMENT =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_1;

// Feature flag: usar chat/completions ao invés de responses
const AZURE_USE_CHAT_COMPLETIONS = (process.env.AZURE_USE_CHAT_COMPLETIONS || 'false').toLowerCase() === 'true';

// Proxy corporativo (aceita HTTP_PROXY/HTTPS_PROXY/NO_PROXY em maiúsculas/minúsculas)
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  undefined;

function shouldBypassProxy(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();
    const list = (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^\./, '').toLowerCase());
    return list.some((p) => p === '*' || host === p || host.endsWith(p));
  } catch {
    return false;
  }
}
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
async function fetchWithProxy(url, options = {}) {
  const useProxy = !!dispatcher && !shouldBypassProxy(url);
  const requestOptions = useProxy ? { ...options, dispatcher } : options;
  return fetch(url, requestOptions);
}

function assertAzureEnv() {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_DEPLOYMENT) {
    throw new Error('Azure OpenAI environment variables are not configured for Graph RAG job');
  }
}

/**
 * Chama Azure LLM para extrair nós/arestas de um bloco de texto.
 * Retorna objeto { nodes: [], edges: [] } seguindo o esquema abaixo:
 * nodes: [{ label: string, node_type?: string, properties?: Record<string,any> }]
 * edges: [{ src_label: string, dst_label: string, relation: string, properties?: Record<string,any> }]
 */
async function callAzureExtractGraph({ text }) {
  assertAzureEnv();

  const system = `Você é um extrator de conhecimento. Dado um texto em português (pt-BR), identifique entidades/tópicos relevantes e relações entre eles.

Saída ESTRITA em JSON (sem texto adicional), com o seguinte formato:
{
  "nodes": [
    { "label": "string obrigatória", "node_type": "categoria opcional (pessoa, empresa, regra, processo, produto, etc.)", "properties": { "chave": "valor" } }
  ],
  "edges": [
    { "src_label": "label do nó origem", "dst_label": "label do nó destino", "relation": "nome da relação", "properties": { "chave": "valor" } }
  ]
}

Regras:
- Evite duplicar nós iguais (mesmo label).
- Use labels curtos e descritivos.
- Use "relation" curta e clara (ex.: "regula", "pertence", "usa", "depende", "contém").
- Se não houver relações, deixe "edges" como lista vazia.
`;

  const user = `Texto:
"""
${text}
"""`;

  const basePath = AZURE_USE_CHAT_COMPLETIONS
    ? `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`
    : `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/responses?api-version=${AZURE_OPENAI_API_VERSION}`;
  const url = new URL(basePath, AZURE_OPENAI_ENDPOINT).toString();

  const bypass = shouldBypassProxy(url);
  const route = AZURE_USE_CHAT_COMPLETIONS ? 'chat/completions' : 'responses';
  console.log(`[GraphRAG Azure] url=${url} route=${route} proxy=${PROXY_URL || 'none'} bypass=${bypass}`);

  const messages = AZURE_USE_CHAT_COMPLETIONS
    ? [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]
    : [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: user }] },
      ];

  const body = AZURE_USE_CHAT_COMPLETIONS ? { messages } : { messages };

  const resp = await fetchWithProxy(url, {
    method: 'POST',
    headers: { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {}
    const msg = parsed?.error?.message || txt;
    throw Object.assign(new Error('Falha na extração via Azure'), {
      status: resp.status,
      details: msg,
    });
  }

  const data = await resp.json();
  let outText = '';
  if (!AZURE_USE_CHAT_COMPLETIONS) {
    if (data.output_text && typeof data.output_text === 'string') {
      outText = data.output_text;
    } else if (Array.isArray(data.output) && data.output.length > 0) {
      const parts = data.output[0]?.content ?? [];
      outText = parts.map((p) => p.text ?? '').join('');
    }
  } else {
    outText = data.choices?.[0]?.message?.content ?? '';
  }

  // Tentar isolar JSON
  const jsonMatch = outText.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[0] : outText;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.warn('GraphRAG: resposta não JSON parseável. Retornando vazio. Conteúdo:', outText);
    parsed = { nodes: [], edges: [] };
  }

  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];

  // Sanitização leve
  const cleanNodes = nodes
    .map((n) => ({
      label: String(n?.label || '').trim(),
      node_type: n?.node_type ? String(n.node_type).trim() : null,
      properties: typeof n?.properties === 'object' && n.properties ? n.properties : {},
    }))
    .filter((n) => n.label.length > 0);

  const cleanEdges = edges
    .map((e) => ({
      src_label: String(e?.src_label || '').trim(),
      dst_label: String(e?.dst_label || '').trim(),
      relation: String(e?.relation || '').trim(),
      properties: typeof e?.properties === 'object' && e.properties ? e.properties : {},
    }))
    .filter((e) => e.src_label.length > 0 && e.dst_label.length > 0 && e.relation.length > 0);

  return { nodes: cleanNodes, edges: cleanEdges };
}

function normLabelKey(label) {
  return String(label || '').trim().toLowerCase();
}

/**
 * Upsert de nó por (client_id, kb_type, label).
 */
async function upsertNode(pgClient, { clientId, kbType, label, nodeType, sourceId, properties }) {
  const find = await pgClient.query(
    `SELECT id FROM public.kb_nodes WHERE client_id = $1 AND kb_type = $2 AND label = $3 LIMIT 1`,
    [clientId, kbType, label]
  );
  if (find.rows.length > 0) {
    const id = find.rows[0].id;
    // Atualiza opcionalmente node_type/properties se não nulos
    await pgClient.query(
      `UPDATE public.kb_nodes SET node_type = COALESCE($2, node_type), properties = COALESCE($3::jsonb, properties), updated_at = now()
       WHERE id = $1`,
      [id, nodeType || null, properties ? JSON.stringify(properties) : null]
    );
    return id;
  }
  const ins = await pgClient.query(
    `INSERT INTO public.kb_nodes (client_id, kb_type, label, node_type, source_id, properties)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [clientId, kbType, label, nodeType || null, sourceId || null, properties ? JSON.stringify(properties) : JSON.stringify({})]
  );
  return ins.rows[0].id;
}

/**
 * Cria aresta entre dois nós existentes.
 */
async function insertEdge(pgClient, { clientId, kbType, srcNodeId, dstNodeId, relation, properties }) {
  const ins = await pgClient.query(
    `INSERT INTO public.kb_edges (client_id, kb_type, src_node_id, dst_node_id, relation, properties)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (client_id, kb_type, src_node_id, dst_node_id, relation) DO NOTHING
     RETURNING id`,
    [clientId, kbType, srcNodeId, dstNodeId, relation, properties ? JSON.stringify(properties) : JSON.stringify({})]
  );
  return ins.rows.length > 0 ? ins.rows[0].id : null;
}

/**
 * Executa extração por chunks para um cliente e tipo.
 */
export async function runGraphExtractionForClient(pgClient, { clientId, kbType = 'cliente', limitChunks = 200, piiMode = 'default', sourceId = null } = {}) {
  if (!clientId) throw new Error('clientId obrigatório');
  if (!['cliente', 'operador'].includes(String(kbType || '').toLowerCase())) {
    throw new Error('kbType inválido (use "cliente" ou "operador")');
  }
  const normalizedType = String(kbType).toLowerCase();

  // Buscar chunks ativos do cliente/tipo (opcionalmente restritos a uma fonte específica)
  const params = [clientId, normalizedType];
  let sql =
    `SELECT kc.id, kc.source_id, kc.content, kc.tokens, ks.title, ks.status
       FROM public.kb_chunks kc
       JOIN public.kb_sources ks ON ks.id = kc.source_id
      WHERE kc.client_id = $1 AND kc.kb_type = $2 AND ks.status = 'active'`;
  if (sourceId) {
    sql += ' AND kc.source_id = $3';
    params.push(sourceId);
  }
  sql += ' ORDER BY kc.created_at DESC LIMIT $' + (params.length + 1);
  params.push(Math.max(1, Number(limitChunks || 200)));

  const r = await pgClient.query(sql, params);
  const rows = r.rows || [];
  if (rows.length === 0) {
    return { processed: 0, nodesCreated: 0, edgesCreated: 0 };
  }

  let nodesCreated = 0;
  let edgesCreated = 0;

  // Processar em transação para consistência
  await pgClient.query('BEGIN');

  try {
    for (const row of rows) {
      await pgClient.query('SAVEPOINT sp_chunk');

      const text = piiMode === 'raw' ? row.content : anonymizePII(row.content, 'default');

      let extracted;
      try {
        extracted = await callAzureExtractGraph({ text });
      } catch (e) {
        console.warn('Falha ao extrair grafo de chunk, continuando:', e?.message || e);
        await pgClient.query('ROLLBACK TO SAVEPOINT sp_chunk');
        continue;
      }

      // Deduplicar nós por label dentro deste chunk
      const nodeMap = new Map(); // key: normLabel -> nodeId
      for (const n of extracted.nodes) {
        const key = normLabelKey(n.label);
        if (nodeMap.has(key)) continue;

        const nodeId = await upsertNode(pgClient, {
          clientId,
          kbType: normalizedType,
          label: n.label,
          nodeType: n.node_type || null,
          sourceId: row.source_id,
          properties: n.properties || {},
        });
        nodeMap.set(key, nodeId);
        nodesCreated++;
      }

      for (const e of extracted.edges) {
        const srcKey = normLabelKey(e.src_label);
        const dstKey = normLabelKey(e.dst_label);
        const srcId = nodeMap.get(srcKey);
        const dstId = nodeMap.get(dstKey);

        // Se algum dos nós não foi criado neste passo, tentar buscar no banco
        async function ensureNodeId(label) {
          const k = normLabelKey(label);
          if (nodeMap.has(k)) return nodeMap.get(k);
          const find = await pgClient.query(
            `SELECT id FROM public.kb_nodes WHERE client_id = $1 AND kb_type = $2 AND label = $3 LIMIT 1`,
            [clientId, normalizedType, label]
          );
          if (find.rows.length > 0) {
            const id = find.rows[0].id;
            nodeMap.set(k, id);
            return id;
          }
          const id = await upsertNode(pgClient, {
            clientId,
            kbType: normalizedType,
            label,
            nodeType: null,
            sourceId: row.source_id,
            properties: {},
          });
          nodeMap.set(k, id);
          nodesCreated++;
          return id;
        }

        const srcNodeId = srcId || (await ensureNodeId(e.src_label));
        const dstNodeId = dstId || (await ensureNodeId(e.dst_label));

        try {
          if (!srcNodeId || !dstNodeId) {
            // IDs inválidos ou não encontrados; pular aresta
            continue;
          }
          await pgClient.query('SAVEPOINT sp_edge');
          const edgeId = await insertEdge(pgClient, {
            clientId,
            kbType: normalizedType,
            srcNodeId,
            dstNodeId,
            relation: e.relation,
            properties: e.properties || {},
          });
          if (edgeId) edgesCreated++;
        } catch (errEdge) {
          console.warn('GraphRAG: falha ao inserir aresta; revertendo savepoint e seguindo:', errEdge?.message || errEdge);
          await pgClient.query('ROLLBACK TO SAVEPOINT sp_edge');
        }
      }
    }

    await pgClient.query('COMMIT');
  } catch (err) {
    await pgClient.query('ROLLBACK');
    throw err;
  }

  return { processed: rows.length, nodesCreated, edgesCreated };
}

export default {
  runGraphExtractionForClient,
};