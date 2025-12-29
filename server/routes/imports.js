import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { parse as csvParse } from 'csv-parse/sync';

/**
 * Rotas de importação (CSV/XLSX) de funcionários e criação opcional de usuários.
 *
 * Montagem recomendada em server/index.js (protegida por RBAC e tenant):
 *   app.use('/api/imports', requireAuth(pgClient), requireTenant(pgClient), importsRoutes(pgClient))
 *
 * Endpoint:
 *   - POST /api/imports/employees?dry_run=true|false&create_users=true|false&tipo_usuario=interno|externo
 *     - multipart/form-data com campo "file"
 *     - Colunas esperadas (case-insensitive, com acentos aceitos): 
 *       matricula, nome, email, matricula_supervisor, supervisor, funcao
 *     - Se create_users=true, cria/atualiza public.users (sem senha), cria vínculo em user_clients com permissões padrão (falsas)
 *       e user_employee_links (vincula usuário à matrícula no cliente corrente).
 *     - Se dry_run=true (padrão: true), executa validação e simula upserts em transação revertida.
 */

const upload = multer({ storage: multer.memoryStorage() });

/**
 * Normaliza nomes de colunas para o conjunto canônico usado pelo backend.
 */
function normalizeHeader(h) {
  if (!h) return '';
  return String(h)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9_]+/g, '_') // espaços/traços para _
    .replace(/^_+|_+$/g, '');
}

/**
 * Mapeia um objeto de linha para os campos canônicos esperados.
 */
function canonizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    out[normalizeHeader(k)] = v;
  }
  return {
    matricula: out.matricula ?? out.id ?? '',
    nome: out.nome ?? out.name ?? '',
    email: out.email ?? '',
    matricula_supervisor: out.matricula_supervisor ?? out.supervisor_id ?? '',
    supervisor: out.supervisor ?? '',
    funcao: out.funcao ?? out.funcao_cargo ?? out.cargo ?? '',
  };
}

/**
 * Parser de CSV a partir de buffer.
 */
function parseCSV(buffer) {
  const text = buffer.toString('utf8');
  const records = csvParse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records.map(canonizeRow);
}

/**
 * Parser de XLSX a partir de buffer.
 */
function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  return json.map(canonizeRow);
}

/**
 * Validação mínima de linha.
 */
function validateRow(rec) {
  const errors = [];
  const matricula = String(rec.matricula || '').trim();
  const nome = String(rec.nome || '').trim();
  const funcao = String(rec.funcao || '').trim();

  if (!matricula) errors.push('matricula ausente');
  if (!nome) errors.push('nome ausente');
  if (!funcao) errors.push('funcao ausente');

  // Email é opcional (apenas necessário se create_users=true)
  if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(rec.email).trim())) {
    errors.push('email invalido');
  }
  return errors;
}

export function importsRoutes(pgClient) {
  const router = express.Router();

  /**
   * POST /api/imports/employees
   * Multipart: file
   * Query: dry_run=true|false (default true), create_users=true|false (default false), tipo_usuario=interno|externo (default interno)
   */
  router.post('/employees', upload.single('file'), async (req, res) => {
    const clientId = req.clientId;
    const dryRun = String(req.query?.dry_run ?? 'true').toLowerCase() === 'true';
    const createUsers = String(req.query?.create_users ?? 'false').toLowerCase() === 'true';
    const tipoUsuario = String(req.query?.tipo_usuario ?? 'interno').toLowerCase() === 'externo' ? 'externo' : 'interno';

    if (!req.file || !req.file.buffer || !req.file.originalname) {
      return res.status(400).json({ error: 'Arquivo (file) é obrigatório' });
    }

    // Parse planilha
    let rows = [];
    try {
      const name = req.file.originalname.toLowerCase();
      if (name.endsWith('.csv')) {
        rows = parseCSV(req.file.buffer);
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        rows = parseXLSX(req.file.buffer);
      } else {
        return res.status(400).json({ error: 'Formato de arquivo não suportado. Use CSV ou XLSX.' });
      }
    } catch (e) {
      console.error('Import parse error:', e);
      return res.status(400).json({ error: 'Falha ao ler arquivo. Verifique o formato/colunas.' });
    }

    // Validação preliminar
    const issues = [];
    const validRecs = [];
    rows.forEach((r, idx) => {
      const rec = {
        matricula: String(r.matricula || '').trim(),
        nome: String(r.nome || '').trim(),
        email: r.email ? String(r.email).trim() : '',
        matricula_supervisor: r.matricula_supervisor ? String(r.matricula_supervisor).trim() : '',
        supervisor: r.supervisor ? String(r.supervisor).trim() : '',
        funcao: String(r.funcao || '').trim(),
      };
      const errs = validateRow(rec);
      if (errs.length > 0) {
        issues.push({ row: idx + 1, errors: errs, data: rec });
      } else {
        validRecs.push(rec);
      }
    });

    if (issues.length > 0) {
      // Em dry_run: ainda assim retorna relatório; em execução real, bloquear
      if (!dryRun) {
        return res.status(422).json({ error: 'Erros de validação na planilha', issues });
      }
    }

    const report = {
      client_id: clientId,
      total_rows: rows.length,
      valid_rows: validRecs.length,
      invalid_rows: issues.length,
      inserted_employees: 0,
      updated_employees: 0,
      created_users: 0,
      linked_users: 0,
      notes: [],
      dry_run: dryRun,
    };

    // Execução em transação
    try {
      await pgClient.query('BEGIN');

      for (const rec of validRecs) {
        // Upsert employees (preferimos UPDATE->INSERT para contagem clara)
        const upd = await pgClient.query(
          `UPDATE public.employees
              SET nome = $3,
                  matricula_supervisor = NULLIF($4,''),
                  supervisor = NULLIF($5,''),
                  funcao = $6,
                  updated_at = now()
            WHERE client_id = $1 AND matricula = $2`,
          [clientId, rec.matricula, rec.nome, rec.matricula_supervisor, rec.supervisor, rec.funcao]
        );
        if (upd.rowCount === 0) {
          await pgClient.query(
            `INSERT INTO public.employees (client_id, matricula, nome, matricula_supervisor, supervisor, funcao)
             VALUES ($1, $2, $3, NULLIF($4,''), NULLIF($5,''), $6)`,
            [clientId, rec.matricula, rec.nome, rec.matricula_supervisor, rec.supervisor, rec.funcao]
          );
          report.inserted_employees += 1;
        } else {
          report.updated_employees += 1;
        }

        if (createUsers && rec.email) {
          // Busca/insere usuário
          const sel = await pgClient.query(
            `SELECT id FROM public.users WHERE email ILIKE $1 LIMIT 1`,
            [rec.email]
          );
          let userId;
          let createdUser = false;
          if (sel.rows.length > 0) {
            userId = sel.rows[0].id;
          } else {
            const ins = await pgClient.query(
              `INSERT INTO public.users (email, full_name, status, must_reset_password)
               VALUES ($1, $2, 'active', TRUE)
               ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
               RETURNING id`,
              [rec.email, rec.nome]
            );
            userId = ins.rows[0].id;
            createdUser = true;
          }

          if (createdUser) {
            report.created_users += 1;
          }

          // user_clients (permissões padrão)
          await pgClient.query(
            `INSERT INTO public.user_clients (user_id, client_id, tipo_usuario, can_start_chat, can_edit_kb, can_view_team_chats, can_view_all_client_chats)
             VALUES ($1, $2, $3, FALSE, FALSE, FALSE, FALSE)
             ON CONFLICT (user_id, client_id) DO NOTHING`,
            [userId, clientId, tipoUsuario]
          );

          // Vincular matrícula ao usuário neste cliente
          await pgClient.query(
            `INSERT INTO public.user_employee_links (user_id, client_id, matricula)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, client_id) DO UPDATE SET matricula = EXCLUDED.matricula`,
            [userId, clientId, rec.matricula]
          );
          report.linked_users += 1;
        }
      }

      if (dryRun) {
        await pgClient.query('ROLLBACK');
        report.notes.push('Transação revertida (dry_run=true). Nenhuma alteração persistida.');
      } else {
        await pgClient.query('COMMIT');
      }

      // Sempre retornar relatório e eventuais issues de validação
      return res.json({ ok: true, report, issues: issues });
    } catch (err) {
      try {
        await pgClient.query('ROLLBACK');
      } catch {}
      console.error('Import employees error:', err);
      return res.status(500).json({ error: 'Erro ao processar importação', details: String(err?.message || err) });
    }
  });

  return router;
}