/**
 * Middlewares de autorização baseados em req.userPerms,
 * que deve ser preenchido previamente por requireTenant(pgClient).
 *
 * Cada verificação retorna 403 se a permissão não estiver habilitada.
 */

function ensurePerm(req, res, flag) {
  if (!req.userPerms || req.userPerms[flag] !== true) {
    return res.status(403).json({ error: 'Acesso negado', missing_permission: flag });
  }
  return null;
}

export function requireCanStartChat() {
  return function (req, res, next) {
    const err = ensurePerm(req, res, 'can_start_chat');
    if (err) return;
    return next();
  };
}

export function requireCanEditKB() {
  return function (req, res, next) {
    const err = ensurePerm(req, res, 'can_edit_kb');
    if (err) return;
    return next();
  };
}

export function requireCanViewTeamChats() {
  return function (req, res, next) {
    const err = ensurePerm(req, res, 'can_view_team_chats');
    if (err) return;
    return next();
  };
}

export function requireCanViewAllClientChats() {
  return function (req, res, next) {
    const err = ensurePerm(req, res, 'can_view_all_client_chats');
    if (err) return;
    return next();
  };
}

export function requireCanManageScenarios() {
  return function (req, res, next) {
    const err = ensurePerm(req, res, 'can_manage_scenarios');
    if (err) return;
    return next();
  };
}

/**
 * Helper opcional: exige qualquer uma das permissões.
 * Uso: app.get('/rota', requireAny(['can_edit_kb','can_view_all_client_chats']))
 */
export function requireAny(flags = []) {
  return function (req, res, next) {
    if (!req.userPerms) {
      return res.status(403).json({ error: 'Acesso negado', reason: 'no_perms_loaded' });
    }
    for (const f of flags) {
      if (req.userPerms[f] === true) {
        return next();
      }
    }
    return res.status(403).json({ error: 'Acesso negado', missing_any_of: flags });
  };
}