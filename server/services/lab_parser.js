import xlsx from 'xlsx';
import { parse as csvParseSync } from 'csv-parse/sync';

/**
 * Parser de base de transcrições (CSV ou XLSX) com validação dos campos:
 * - IdAtendimento
 * - Message
 * - Role (agent|bot|user)
 * - Ordem (inteiro)
 * - MotivoDeContato
 *
 * Saída normalizada:
 *   {
 *     atendimento_id: string,
 *     motivo: string,
 *     seq: number,
 *     role_raw: 'agent'|'bot'|'user'|string,
 *     role_norm: 'operator'|'bot'|'customer'|null,
 *     message_text: string
 *   }
 *
 * Também retorna estatísticas úteis para progressão:
 *   - totalDistinctIds: número distinto de IdAtendimentos
 *   - motivoDistinctIds: mapa { motivo: count distinto de IdAtendimentos }
 *   - warnings: mensagens de aviso (ex: role desconhecido, ordem não numérica)
 */
export async function parseTranscriptBase({ buffer, filename, mime, mapping }) {
  const kind = guessFileKind({ filename, mime });
  if (kind === 'csv') {
    return parseCsv(buffer, mapping);
  }
  if (kind === 'xlsx') {
    return parseXlsx(buffer, mapping);
  }
  throw new Error('Formato de arquivo não suportado. Use CSV ou XLSX');
}

/**
 * Detecta tipo de arquivo a partir do mimetype ou extensão.
 */
function guessFileKind({ filename, mime }) {
  const m = String(mime || '').toLowerCase();
  const f = String(filename || '').toLowerCase();

  if (m.includes('text/csv')) return 'csv';
  if (m.includes('application/vnd.ms-excel')) return hasXlsExt(f) ? 'xlsx' : 'csv';
  if (m.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) return 'xlsx';

  if (f.endsWith('.csv')) return 'csv';
  if (hasXlsExt(f)) return 'xlsx';

  return 'unknown';
}

function hasXlsExt(name) {
  return name.endsWith('.xlsx') || name.endsWith('.xls');
}

/**
 * Normaliza nome de coluna para uma chave canônica.
 */
function normalizeHeaderName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  if (n === 'idatendimento' || n === 'atendimentoid' || n === 'id' || n === 'id_atendimento') return 'idAtendimento';
  if (n === 'message' || n === 'mensagem' || n === 'texto' || n === 'text') return 'message';
  if (n === 'role' || n === 'papel' || n === 'quem' || n === 'remetente') return 'role';
  if (n === 'ordem' || n === 'seq' || n === 'sequencia' || n === 'ordemdasmensagens' || n === 'ordem_mensagem') return 'ordem';
  if (n === 'motivodecontato' || n === 'motivo' || n === 'cenário' || n === 'cenario' || n === 'contato') return 'motivoDeContato';
  return n; // fallback: retorna original normalizado
}

// Conjunto de chaves canônicas obrigatórias
const REQUIRED_CANONICALS = ['idAtendimento', 'message', 'role', 'ordem', 'motivoDeContato'];

/**
 * Retorna o valor de uma coluna a partir de um objeto de record (chaves = cabeçalhos),
 * buscando por equivalência canônica do nome.
 */
function getRecordValue(record, canonicalKey) {
  const keys = Object.keys(record || {});
  for (const k of keys) {
    const canon = normalizeHeaderName(k);
    if (canon === canonicalKey) {
      return record[k];
    }
  }
  return undefined;
}

/**
 * Variante que dá prioridade ao mapeamento explícito (canonicalKey -> originalHeader),
 * com quedas para match case-insensitive e por normalização, e por fim usa getRecordValue().
 */
function getRecordValueMapped(record, canonicalKey, mapping) {
  if (mapping && mapping[canonicalKey]) {
    const wanted = String(mapping[canonicalKey]).trim();
    if (wanted) {
      // match exato
      if (Object.prototype.hasOwnProperty.call(record, wanted)) {
        return record[wanted];
      }
      // match case-insensitive
      const keys = Object.keys(record || {});
      const foundKey = keys.find((k) => String(k).trim().toLowerCase() === wanted.toLowerCase());
      if (foundKey) {
        return record[foundKey];
      }
      // match por normalização
      const targetNorm = normalizeHeaderName(wanted);
      for (const k of keys) {
        if (normalizeHeaderName(k) === targetNorm) {
          return record[k];
        }
      }
    }
  }
  return getRecordValue(record, canonicalKey);
}

/**
 * Normaliza o papel (Role) para role_raw/role_norm padronizados.
 * - agent -> operator
 * - bot   -> bot
 * - user  -> customer
 * Aceita variações de capitalização; mantém role_raw como informado (lowercase).
 */
function normalizeRoleValue(role) {
  const raw = String(role || '').trim().toLowerCase();
  if (!raw) return { role_raw: '', role_norm: null };

  if (raw === 'agent' || raw === 'agente' || raw === 'atendente' || raw === 'operator' || raw === 'assistentehumano') {
    return { role_raw: 'agent', role_norm: 'operator' };
  }
  if (raw === 'bot' || raw === 'assistente' || raw === 'robot' || raw === 'virtual') {
    return { role_raw: 'bot', role_norm: 'bot' };
  }
  if (raw === 'user' || raw === 'cliente' || raw === 'consumidor' || raw === 'pessoa') {
    return { role_raw: 'user', role_norm: 'customer' };
  }
  // desconhecido
  return { role_raw: raw, role_norm: null };
}

function coerceInt(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function sanitizeText(val) {
  const s = String(val ?? '').replace(/\r/g, '').trim();
  return s;
}

/**
 * Calcula estatísticas de Ids distintos e por motivo.
 */
function computeStats(rows) {
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

  return {
    totalDistinctIds: ids.size,
    motivoDistinctIds,
  };
}

/**
 * Parser para CSV (buffer).
 */
function parseCsv(buffer, mapping) {
  const text = bufferToUtf8(buffer);

  function detectCsvDelimiter(src) {
    const firstLine = (String(src || '').split(/\r?\n/).find((l) => l.trim().length > 0) || '');
    const sc = (firstLine.match(/;/g) || []).length;
    const cc = (firstLine.match(/,/g) || []).length;
    return sc > cc ? ';' : ',';
  }

  let records;
  try {
    const delimiter = detectCsvDelimiter(text);
    records = csvParseSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
    });
  } catch (e) {
    throw new Error(`Falha ao ler CSV: ${String(e?.message || e)}`);
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { rows: [], stats: { totalDistinctIds: 0, motivoDistinctIds: {} }, warnings: ['Nenhuma linha de dados no CSV'] };
  }

  const warnings = [];
  const rows = [];

  // Fallback de seq quando ausência/valores inválidos: por IdAtendimento incremental
  const seqTracker = new Map(); // atendimento_id -> seqAtual

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];

    const idAt = sanitizeText(getRecordValueMapped(rec, 'idAtendimento', mapping));
    const msg = sanitizeText(getRecordValueMapped(rec, 'message', mapping));
    const role = getRecordValueMapped(rec, 'role', mapping);
    const ordemVal = getRecordValueMapped(rec, 'ordem', mapping);
    const motivo = sanitizeText(getRecordValueMapped(rec, 'motivoDeContato', mapping));

    const missing = [];
    if (!idAt) missing.push('IdAtendimento');
    if (!msg) missing.push('Message');
    if (role === undefined || role === null || String(role).trim() === '') missing.push('Role');
    if (ordemVal === undefined || ordemVal === null || String(ordemVal).trim() === '') missing.push('Ordem');
    if (!motivo) missing.push('MotivoDeContato');

    if (missing.length > 0) {
      warnings.push(`Linha ${i + 2}: campos ausentes -> ${missing.join(', ')}`);
      continue; // ignora linha inválida
    }

    const { role_raw, role_norm } = normalizeRoleValue(role);
    if (!role_norm) {
      warnings.push(`Linha ${i + 2}: Role desconhecido (${String(role).trim()})`);
    }

    let seq = coerceInt(ordemVal);
    if (seq === null) {
      const k = idAt;
      const cur = (seqTracker.get(k) || 0) + 1;
      seqTracker.set(k, cur);
      seq = cur;
      warnings.push(`Linha ${i + 2}: Ordem inválida; atribuído seq=${seq} automaticamente`);
    }

    rows.push({
      atendimento_id: idAt,
      motivo,
      seq,
      role_raw,
      role_norm,
      message_text: msg,
    });
  }

  const stats = computeStats(rows);
  return { rows, stats, warnings };
}

/**
 * Parser para XLSX (planilha Excel).
 * Considera a primeira planilha e a primeira linha como cabeçalho.
 */
function parseXlsx(buffer, mapping) {
  let wb;
  try {
    wb = xlsx.read(buffer, { type: 'buffer' });
  } catch (e) {
    throw new Error(`Falha ao ler XLSX: ${String(e?.message || e)}`);
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { rows: [], stats: { totalDistinctIds: 0, motivoDistinctIds: {} }, warnings: ['Arquivo XLSX sem planilhas'] };
  }
  const sheet = wb.Sheets[sheetName];
  const records = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  if (!Array.isArray(records) || records.length === 0) {
    return { rows: [], stats: { totalDistinctIds: 0, motivoDistinctIds: {} }, warnings: ['Nenhuma linha de dados na planilha'] };
  }

  const warnings = [];
  const rows = [];
  const seqTracker = new Map();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];

    const idAt = sanitizeText(getRecordValueMapped(rec, 'idAtendimento', mapping));
    const msg = sanitizeText(getRecordValueMapped(rec, 'message', mapping));
    const role = getRecordValueMapped(rec, 'role', mapping);
    const ordemVal = getRecordValueMapped(rec, 'ordem', mapping);
    const motivo = sanitizeText(getRecordValueMapped(rec, 'motivoDeContato', mapping));

    const missing = [];
    if (!idAt) missing.push('IdAtendimento');
    if (!msg) missing.push('Message');
    if (role === undefined || role === null || String(role).trim() === '') missing.push('Role');
    if (ordemVal === undefined || ordemVal === null || String(ordemVal).trim() === '') missing.push('Ordem');
    if (!motivo) missing.push('MotivoDeContato');

    if (missing.length > 0) {
      warnings.push(`Linha ${i + 2}: campos ausentes -> ${missing.join(', ')}`);
      continue;
    }

    const { role_raw, role_norm } = normalizeRoleValue(role);
    if (!role_norm) {
      warnings.push(`Linha ${i + 2}: Role desconhecido (${String(role).trim()})`);
    }

    let seq = coerceInt(ordemVal);
    if (seq === null) {
      const k = idAt;
      const cur = (seqTracker.get(k) || 0) + 1;
      seqTracker.set(k, cur);
      seq = cur;
      warnings.push(`Linha ${i + 2}: Ordem inválida; atribuído seq=${seq} automaticamente`);
    }

    rows.push({
      atendimento_id: idAt,
      motivo,
      seq,
      role_raw,
      role_norm,
      message_text: msg,
    });
  }

  const stats = computeStats(rows);
  return { rows, stats, warnings };
}

/**
 * Gera preview de cabeçalhos e amostra de linhas, além de sugestão de mapeamento canônico.
 * - Usa a primeira aba para XLSX
 * - Autodetecta delimitador ; ou , em CSV
 * - Amostra limitada a até 10 linhas
 */
export async function getHeadersPreview({ buffer, filename, mime }) {
  const kind = guessFileKind({ filename, mime });
  if (kind === 'csv') {
    const text = bufferToUtf8(buffer);

    // detecta delimitador e parse completo (amostra será fatiada)
    const firstLine = (String(text || '').split(/\r?\n/).find((l) => l.trim().length > 0) || '');
    const sc = (firstLine.match(/;/g) || []).length;
    const cc = (firstLine.match(/,/g) || []).length;
    const delimiter = sc > cc ? ';' : ',';

    let records = [];
    try {
      records = csvParseSync(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
      });
    } catch (e) {
      throw new Error(`Falha ao ler CSV para preview: ${String(e?.message || e)}`);
    }

    const headers = Array.isArray(records) && records.length > 0 ? Object.keys(records[0]) : (firstLine ? firstLine.split(delimiter) : []);
    const normIndex = {};
    for (const h of headers) {
      normIndex[normalizeHeaderName(h)] = h;
    }
    const suggested = {};
    for (const key of REQUIRED_CANONICALS) {
      if (normIndex[key]) suggested[key] = normIndex[key];
    }
    const canonicalComplete = REQUIRED_CANONICALS.every((k) => !!suggested[k]);
    const sample = (records || []).slice(0, 10);

    return {
      ok: true,
      kind: 'csv',
      delimiter,
      headers,
      suggestedMapping: suggested,
      canonicalComplete,
      sample,
    };
  }

  if (kind === 'xlsx') {
    let wb;
    try {
      wb = xlsx.read(buffer, { type: 'buffer' });
    } catch (e) {
      throw new Error(`Falha ao ler XLSX para preview: ${String(e?.message || e)}`);
    }
    const sheetName = wb.SheetNames[0] || null;
    if (!sheetName) {
      return { ok: true, kind: 'xlsx', sheet: null, headers: [], suggestedMapping: {}, canonicalComplete: false, sample: [] };
    }
    const sheet = wb.Sheets[sheetName];
    const records = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    const headers = Array.isArray(records) && records.length > 0 ? Object.keys(records[0]) : [];
    const normIndex = {};
    for (const h of headers) {
      normIndex[normalizeHeaderName(h)] = h;
    }
    const suggested = {};
    for (const key of REQUIRED_CANONICALS) {
      if (normIndex[key]) suggested[key] = normIndex[key];
    }
    const canonicalComplete = REQUIRED_CANONICALS.every((k) => !!suggested[k]);
    const sample = (records || []).slice(0, 10);

    return {
      ok: true,
      kind: 'xlsx',
      sheet: sheetName,
      headers,
      suggestedMapping: suggested,
      canonicalComplete,
      sample,
    };
  }

  throw new Error('Formato de arquivo não suportado para preview. Use CSV ou XLSX');
}

function bufferToUtf8(buf) {
  if (typeof buf === 'string') return buf;
  if (buf instanceof Uint8Array) return new TextDecoder('utf-8').decode(buf);
  if (Buffer.isBuffer(buf)) return buf.toString('utf-8');
  // fallback
  try {
    return String(buf);
  } catch {
    return '';
  }
}

export default { parseTranscriptBase, getHeadersPreview };