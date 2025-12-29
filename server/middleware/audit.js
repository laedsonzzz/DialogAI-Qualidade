/**
 * Utilitário de auditoria
 * Registra eventos na tabela public.audit_log (ver migração 003).
 *
 * Uso:
 *   await writeAudit(pgClient, req, {
 *     entityType: 'knowledge_base',
 *     entityId: kbId,
 *     action: 'create' | 'update' | 'delete' | 'login' | ...,
 *     before: { ... },   // JSON serializável ou null
 *     after:  { ... },   // JSON serializável ou null
 *     clientId: 'uuid'   // opcional (fallback: req.clientId)
 *   });
 */

function getIp(req) {
  try {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .toString()
      .split(',')[0]
      .trim();
  } catch {
    return null;
  }
}

function getUA(req) {
  try {
    return (req.headers['user-agent'] || '').toString();
  } catch {
    return null;
  }
}

/**
 * Escreve um evento de auditoria.
 * - actor_user_id: req.user?.id
 * - client_id: clientId informado ou req.clientId (se presente)
 * - entity_type / entity_id / action: obrigatórios
 * - before / after: JSONB opcionais
 */
export async function writeAudit(pgClient, req, { entityType, entityId, action, before = null, after = null, clientId = null }) {
  if (!entityType || !entityId || !action) {
    throw new Error('writeAudit: parâmetros obrigatórios ausentes (entityType, entityId, action)');
  }
  const actorId = req?.user?.id || null;
  const cid = clientId || req?.clientId || null;
  const ip = getIp(req);
  const ua = getUA(req);

  await pgClient.query(
    `INSERT INTO public.audit_log
       (actor_user_id, client_id, entity_type, entity_id, action, before, after, ip, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, now())`,
    [
      actorId,
      cid,
      String(entityType),
      String(entityId),
      String(action),
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip || null,
      ua || null,
    ]
  );
}