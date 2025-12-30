import { ProxyAgent, fetch } from 'undici';

/**
 * Serviço de embeddings Azure OpenAI com suporte a proxy corporativo.
 * Lê variáveis canônicas e faz fallback para *_1 quando não setadas.
 */

const AZURE_OPENAI_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ||
  process.env.AZURE_OPENAI_ENDPOINT_1;

const AZURE_OPENAI_API_KEY =
  process.env.AZURE_OPENAI_API_KEY ||
  process.env.AZURE_OPENAI_API_KEY_1;

const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ||
  process.env.AZURE_OPENAI_API_VERSION_1;

const AZURE_OPENAI_EMBED_DEPLOYMENT =
  process.env.AZURE_OPENAI_EMBED_DEPLOYMENT ||
  process.env.AZURE_OPENAI_EMBED_DEPLOYMENT_1 ||
  'text-embedding-3-small';

const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);

/**
 * Proxy corporativo (aceita HTTP_PROXY/HTTPS_PROXY/NO_PROXY em maiúsculas/minúsculas)
 */
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

export function assertAzureEmbedEnv() {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_EMBED_DEPLOYMENT) {
    throw new Error('Azure OpenAI embeddings environment variables are not configured');
  }
}

/**
 * Cria um embedder que recebe uma lista de textos e retorna uma lista de vetores numéricos.
 * - Normaliza dimensão (trunca ou preenche com zeros para EMBEDDING_DIM)
 * - Lança erro detalhado para diagnósticos
 */
export function createAzureEmbedder() {
  assertAzureEmbedEnv();

  // Monta URL de embeddings (Azure)
  const basePath = `openai/deployments/${AZURE_OPENAI_EMBED_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
  const url = new URL(basePath, AZURE_OPENAI_ENDPOINT).toString();

  async function embed(texts = []) {
    if (!Array.isArray(texts)) {
      throw new Error('embed(texts): "texts" deve ser um array de strings');
    }
    const inputs = texts.map((t) => (typeof t === 'string' ? t : String(t)));

    // Debug leve (sem chaves)
    const bypass = shouldBypassProxy(url);
    console.log(`[Azure Embeddings] url=${url} deployment=${AZURE_OPENAI_EMBED_DEPLOYMENT} version=${AZURE_OPENAI_API_VERSION} proxy=${PROXY_URL || 'none'} bypass=${bypass}`);

    const resp = await fetchWithProxy(url, {
      method: 'POST',
      headers: {
        'api-key': AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: inputs }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      let parsed;
      try {
        parsed = JSON.parse(txt);
      } catch {}
      const code = parsed?.error?.code;
      const msg = parsed?.error?.message || parsed?.error || txt;
      console.error('Azure Embeddings error:', resp.status, msg, { code });
      throw Object.assign(new Error('Erro ao obter embeddings'), {
        status: resp.status,
        details: msg,
        code,
      });
    }

    const data = await resp.json();

    // Estrutura esperada (OpenAI/Azure): { data: [{ embedding: number[], index: 0 }, ...] }
    const items = Array.isArray(data?.data) ? data.data : [];
    const vectors = items.map((d) => normalizeVector(Array.isArray(d?.embedding) ? d.embedding : []));

    // Garantir cardinalidade
    if (vectors.length !== inputs.length) {
      console.warn(`Embeddings cardinalidade divergente: inputs=${inputs.length} outputs=${vectors.length}`);
    }

    return vectors;
  }

  function normalizeVector(vec = []) {
    const out = Array.isArray(vec) ? vec.slice(0, EMBEDDING_DIM) : [];
    if (out.length < EMBEDDING_DIM) {
      // Preenche com zeros se necessário
      out.push(...Array(EMBEDDING_DIM - out.length).fill(0));
    }
    return out.map((x) => (typeof x === 'number' ? x : Number(x) || 0));
  }

  return { embed };
}

export default {
  createAzureEmbedder,
  assertAzureEmbedEnv,
};