import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Serviço de ingestão de documentos para RAG:
 * - Suporta PDF, DOCX e TXT
 * - Validação de mimetype e assinatura mágica básica
 * - Normalização de texto e anonimização de PII opcional
 * - Limites configuráveis via .env:
 *    UPLOAD_ALLOWED_MIME (CSV)
 *    UPLOAD_MAX_MB (por arquivo)
 */

const ALLOWED_MIME = String(process.env.UPLOAD_ALLOWED_MIME || 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 10);
const BYTE_LIMIT = Math.max(1, UPLOAD_MAX_MB) * 1024 * 1024;

/**
 * Valida mimetype informado contra lista permitida e assinatura mágica (best-effort).
 */
export function validateFile(buffer, filename, mime) {
  if (!buffer || !(buffer instanceof Buffer)) {
    throw new Error('Arquivo inválido: buffer ausente ou tipo incorreto');
  }
  if (buffer.length === 0) {
    throw new Error('Arquivo inválido: vazio');
  }
  if (buffer.length > BYTE_LIMIT) {
    throw Object.assign(new Error(`Arquivo excede o limite de ${UPLOAD_MAX_MB} MB`), { code: 'FILE_TOO_LARGE' });
  }

  const normalizedMime = String(mime || '').toLowerCase().trim();
  if (!ALLOWED_MIME.includes(normalizedMime)) {
    throw Object.assign(new Error(`Tipo de arquivo não permitido: ${normalizedMime}`), {
      code: 'MIME_NOT_ALLOWED',
      allowed: ALLOWED_MIME,
    });
  }

  const name = String(filename || '').toLowerCase();
  const sig = buffer.subarray(0, 8);

  // Assinaturas básicas:
  // PDF: "%PDF"
  // DOCX: Zip header "PK" e extensão .docx
  // TXT: sem assinatura específica (permitimos text/plain)
  if (normalizedMime === 'application/pdf') {
    const isPdf = sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46; // "%PDF"
    if (!isPdf) {
      throw Object.assign(new Error('Assinatura de arquivo não condiz com PDF'), { code: 'MAGIC_MISMATCH' });
    }
  } else if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const isZip = sig[0] === 0x50 && sig[1] === 0x4B; // "PK"
    const hasDocxExt = name.endsWith('.docx');
    if (!isZip || !hasDocxExt) {
      throw Object.assign(new Error('Assinatura/extensão não condiz com DOCX'), { code: 'MAGIC_MISMATCH' });
    }
  } else if (normalizedMime === 'text/plain') {
    // Checagem leve: se contém muitos bytes não imprimíveis, suspeito
    const asciiPrintableRatio = printableRatio(buffer);
    if (asciiPrintableRatio < 0.6) {
      // Ainda permitimos, mas avisamos; rotas podem rejeitar se desejado
      console.warn(`Arquivo TXT com baixa taxa de caracteres imprimíveis: ratio=${asciiPrintableRatio.toFixed(2)}`);
    }
  }

  return true;
}

/**
 * Extrai texto do arquivo conforme mimetype.
 */
export async function extractTextFromFile({ buffer, filename, mime }) {
  validateFile(buffer, filename, mime);

  const normalizedMime = String(mime || '').toLowerCase().trim();
  if (normalizedMime === 'application/pdf') {
    return await parsePdf(buffer);
  }
  if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return await parseDocx(buffer);
  }
  if (normalizedMime === 'text/plain') {
    return parseTxt(buffer);
  }

  throw Object.assign(new Error(`Mimetype não suportado: ${normalizedMime}`), { code: 'MIME_NOT_SUPPORTED' });
}

/**
 * PDF -> texto (pdf-parse)
 */
async function parsePdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    const text = normalizeText(data?.text || '');
    return text;
  } catch (e) {
    console.error('Falha ao parsear PDF:', e);
    throw Object.assign(new Error('Falha ao ler PDF'), { cause: e });
  }
}

/**
 * DOCX -> texto (mammoth.extractRawText)
 */
async function parseDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = normalizeText(result?.value || '');
    return text;
  } catch (e) {
    console.error('Falha ao parsear DOCX:', e);
    throw Object.assign(new Error('Falha ao ler DOCX'), { cause: e });
  }
}

/**
 * TXT -> texto
 */
function parseTxt(buffer) {
  try {
    // Tenta UTF-8; se falhar, substitui caracteres inválidos
    const text = buffer.toString('utf8');
    return normalizeText(text);
  } catch (e) {
    console.error('Falha ao converter TXT:', e);
    throw Object.assign(new Error('Falha ao ler TXT'), { cause: e });
  }
}

/**
 * Normaliza texto:
 * - remove caracteres de controle (exceto \n)
 * - colapsa espaços múltiplos
 * - preserva quebras de linha razoáveis
 */
export function normalizeText(text) {
  if (!text) return '';
  const noCtrl = text.replace(/[^\S\r\n\t ]/g, ''); // remove chars estranhos, preserva \n e espaços
  const collapsed = noCtrl.replace(/[ \t]+/g, ' ');
  const lines = collapsed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Junta linhas, mas mantém separação mínima
  return lines.join('\n');
}

/**
 * Anonimiza PII (CPF, e-mail, telefone) por padrão.
 * - Se mode = 'raw', retorna texto inalterado
 */
export function anonymizePII(text, mode = 'default') {
  if (mode === 'raw') return text || '';

  let out = String(text || '');

  // E-mails
  out = out.replace(
    /([a-zA-Z0-9._%+-]{1,})@([a-zA-Z0-9.-]{1,}\.[a-zA-Z]{2,})/g,
    (m, user, domain) => `${user.slice(0, 1)}***@${domain.split('.')[0].slice(0, 1)}***.${domain.split('.').slice(1).join('.')}`
  );

  // Telefones (diversos formatos brasileiros)
  out = out.replace(
    /(\(?\d{2}\)?\s?)?(\d{4,5}[-\s]?\d{4})/g,
    (m) => maskTail(m, 4)
  );

  // CPF (999.999.999-99 ou somente dígitos)
  out = out.replace(
    /(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})/g,
    (m) => maskTail(m.replace(/\D/g, ''), 4) // aplica sobre dígitos
  );

  return out;
}

/**
 * Retorna proporção (0..1) de bytes imprimíveis aproximados.
 */
function printableRatio(buffer) {
  const total = buffer.length;
  let printable = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    // ASCII printable aprox: 9(tab), 10(\n), 13(\r), 32..126
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      printable++;
    }
  }
  return total > 0 ? printable / total : 0;
}

/**
 * Mascara o final da string mantendo os últimos n caracteres
 */
function maskTail(str, keepLast = 4) {
  const s = String(str || '');
  const len = s.length;
  if (len <= keepLast) return '*'.repeat(len);
  const masked = '*'.repeat(len - keepLast) + s.slice(len - keepLast);
  return masked;
}

export default {
  validateFile,
  extractTextFromFile,
  normalizeText,
  anonymizePII,
};