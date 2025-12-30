/**
 * Chunker pt-BR com overlap configurável via .env:
 * - RAG_CHUNK_TOKENS (default: 800)
 * - RAG_CHUNK_OVERLAP (default: 200)
 * Estratégia:
 * 1) Segmentar por sentenças (regex pontuação . ! ? ; ) preservando pontuação.
 * 2) Agregar sentenças até atingir o limite de tokens aproximado.
 * 3) Aplicar overlap entre chunks (por palavras).
 * 4) Fallback: janela fixa por tamanho quando não houver sentenças claras.
 */

function getEnvInt(name, def) {
  const raw = process.env[name];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export const DEFAULT_CHUNK_TOKENS = getEnvInt('RAG_CHUNK_TOKENS', 800);
export const DEFAULT_CHUNK_OVERLAP = getEnvInt('RAG_CHUNK_OVERLAP', 200);

/**
 * Aproximação de contagem de tokens (por palavras separadas por whitespace).
 * Não é perfeita, mas suficiente para dimensionar chunks.
 */
export function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // normaliza múltiplos espaços e quebras de linha
  const norm = text.trim().replace(/\s+/g, ' ');
  if (!norm) return 0;
  return norm.split(' ').length;
}

/**
 * Segmentar por sentenças mantendo pontuação.
 * Ex.: "Olá. Tudo bem? Sim!" -> ["Olá.", "Tudo bem?", "Sim!"]
 */
export function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Regex: captura blocos até pontuação final (., !, ?, ;) incluindo a pontuação.
  const re = /[^.!?;]+[.!?;]+|[^.!?;]+$/g;
  const parts = normalized.match(re) || [];
  // limpar espaços extras
  return parts.map((s) => s.trim());
}

/**
 * Constrói uma string a partir de uma lista de palavras.
 */
function wordsToString(words) {
  return (words || []).join(' ').trim();
}

/**
 * Converte texto em lista de palavras normalizadas.
 */
function textToWords(text) {
  const norm = (text || '').trim().replace(/\s+/g, ' ');
  return norm ? norm.split(' ') : [];
}

/**
 * Aplica overlap por palavras: retorna as últimas N palavras do texto.
 */
function tailOverlapWords(text, overlapTokens) {
  if (overlapTokens <= 0) return [];
  const words = textToWords(text);
  if (words.length <= overlapTokens) return words;
  return words.slice(words.length - overlapTokens);
}

/**
 * Fallback de chunking por janela fixa de palavras (tamanho + overlap).
 */
function fixedWindowChunking(text, chunkTokens, overlapTokens) {
  const words = textToWords(text);
  if (words.length === 0) return [];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkTokens, words.length);
    const segment = words.slice(start, end);
    const content = wordsToString(segment);
    chunks.push({ content, tokens: segment.length });

    if (end >= words.length) break;
    // próximo início considera overlap
    start = Math.max(0, end - overlapTokens);
    if (start <= 0) {
      // para evitar loop infinito em casos extremos
      start = end;
    }
  }
  return chunks;
}

/**
 * Chunking principal por sentenças com overlap por palavras.
 * Retorna array de { content, tokens }.
 */
export function chunkText(text, opts = {}) {
  const chunkTokens = Number.isFinite(opts.chunkTokens) && opts.chunkTokens > 0
    ? Math.floor(opts.chunkTokens)
    : DEFAULT_CHUNK_TOKENS;

  const overlapTokens = Number.isFinite(opts.overlapTokens) && opts.overlapTokens >= 0
    ? Math.floor(opts.overlapTokens)
    : DEFAULT_CHUNK_OVERLAP;

  const sentences = splitSentences(text);

  // Fallback: se não houver sentenças suficientes, usa janela fixa
  if (!sentences || sentences.length === 0) {
    return fixedWindowChunking(text, chunkTokens, overlapTokens);
  }

  const chunks = [];
  let current = '';
  let currentTokens = 0;
  let lastChunkTailWords = [];

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const sTokens = countTokens(s);

    if (currentTokens + sTokens <= chunkTokens) {
      // agrega
      current = current ? `${current} ${s}` : s;
      currentTokens += sTokens;
      continue;
    }

    // finalizar chunk atual se possuir conteúdo
    if (currentTokens > 0) {
      chunks.push({ content: current.trim(), tokens: currentTokens });
      lastChunkTailWords = tailOverlapWords(current, overlapTokens);
    }

    // iniciar próximo chunk com overlap (se houver)
    const overlapPrefix = wordsToString(lastChunkTailWords);
    if (overlapPrefix) {
      current = `${overlapPrefix} ${s}`.trim();
      currentTokens = countTokens(current);
      // se overlap + sentença já excede muito, força quebra
      if (currentTokens > chunkTokens) {
        // empacota somente a sentença, mantendo overlap parcial
        current = s;
        currentTokens = sTokens;
      }
    } else {
      current = s;
      currentTokens = sTokens;
    }
  }

  // finalizar último chunk
  if (currentTokens > 0) {
    chunks.push({ content: current.trim(), tokens: currentTokens });
  }

  // Fallback adicional: se algum chunk ficou vazio (não deve), refaz por janela fixa
  if (chunks.some((c) => !c.content || c.tokens <= 0)) {
    return fixedWindowChunking(text, chunkTokens, overlapTokens);
  }

  return chunks;
}

export default {
  chunkText,
  countTokens,
  splitSentences,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_CHUNK_OVERLAP,
};