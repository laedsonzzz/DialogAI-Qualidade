import { ProxyAgent, fetch } from 'undici';

/**
 * Job de análise do Laboratório:
 * - Percorre motivos do run
 * - Atualiza progresso processed_ids_distinct conforme itera IdAtendimento (distintos)
 * - Amostra até N atendimentos por motivo para gerar um resumo LLM consolidado
 * - Persiste em lab_results (status 'ready')
 * - Quando processed == total para o motivo, grava cache em lab_motivos_cache
 * - Ao final, marca lab_runs.status = 'completed' (ou 'failed' em caso de erro fatal)
 */

const LAB_MAX_SAMPLE_ATT = Math.max(1, parseInt(process.env.LAB_MAX_SAMPLE_ATT || '25', 10));
const LAB_MAX_TRANSCRIPT_CHARS = Math.max(1000, parseInt(process.env.LAB_MAX_TRANSCRIPT_CHARS || '30000', 10));

// Azure OpenAI env (mesma convenção de server/index.js)
const AZURE_OPENAI_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ||
  process.env.AZURE_OPENAI_ENDPOINT_1;
const AZURE_OPENAI_API_KEY =
  process.env.AZURE_OPENAI_API_KEY ||
  process.env.AZURE_OPENAI_API_KEY_1;
const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ||
  process.env.AZURE_OPENAI_API_VERSION_1;
const AZURE_OPENAI_DEPLOYMENT =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_1;

// Feature flag: usar chat/completions como fallback direto
const AZURE_USE_CHAT_COMPLETIONS = (process.env.AZURE_USE_CHAT_COMPLETIONS || 'false').toLowerCase() === 'true';

// Proxy
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  undefined;

const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

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

async function fetchWithProxy(url, options = {}) {
  const useProxy = !!dispatcher && !shouldBypassProxy(url);
  const requestOptions = useProxy ? { ...options, dispatcher } : options;
  return fetch(url, requestOptions);
}

function assertAzureEnv() {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_DEPLOYMENT) {
    throw new Error('Azure OpenAI environment variables are not configured');
  }
}

/**
 * Cliente mínimo para Azure Responses API com fallback para chat/completions.
 * Aceita messages no formato da Responses API (role+content parts) OU simples array com content string.
 */
async function azureResponses(messages) {
  assertAzureEnv();
  const basePath = AZURE_USE_CHAT_COMPLETIONS
    ? `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`
    : `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/responses?api-version=${AZURE_OPENAI_API_VERSION}`;
  const url = new URL(basePath, AZURE_OPENAI_ENDPOINT).toString();

  // Converter p/ chat/completions quando for o caso
  const outMessages = AZURE_USE_CHAT_COMPLETIONS
    ? (messages || []).map((m) => ({
        role: m.role,
        content: Array.isArray(m.content) ? m.content.map((p) => p?.text ?? '').join('') : m.content,
      }))
    : messages;

  const resp = await fetchWithProxy(url, {
    method: 'POST',
    headers: {
      'api-key': AZURE_OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: outMessages }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {}
    const code = parsed?.error?.code;
    const msg = parsed?.error?.message || txt;

    // fallback for 404 -> tentar chat/completions
    if (resp.status === 404) {
      try {
        const chatUrl = new URL(
          `openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
          AZURE_OPENAI_ENDPOINT
        ).toString();

        const chatMessages = (messages || []).map((m) => ({
          role: m.role,
          content: Array.isArray(m.content) ? m.content.map((p) => p?.text ?? '').join('') : m.content,
        }));

        const chatResp = await fetchWithProxy(chatUrl, {
          method: 'POST',
          headers: { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chatMessages }),
        });
        if (!chatResp.ok) {
          const cTxt = await chatResp.text();
          throw Object.assign(new Error('Erro ao comunicar com a IA (fallback chat/completions no job)'), {
            status: chatResp.status,
            details: cTxt,
          });
        }
        const cData = await chatResp.json();
        if (cData?.choices && cData.choices[0]?.message?.content) {
          return cData.choices[0].message.content;
        }
        return typeof cData === 'string' ? cData : JSON.stringify(cData);
      } catch (fbErr) {
        throw Object.assign(new Error('Azure fallback failed (job)'), { status: 404, details: String(fbErr?.message || fbErr) });
      }
    }

    throw Object.assign(new Error('Erro ao comunicar com a IA (job)'), { status: resp.status, details: msg, code });
  }

  const data = await resp.json();
  let text = '';
  if (data.output_text && typeof data.output_text === 'string') {
    text = data.output_text;
  } else if (Array.isArray(data.output) && data.output.length > 0) {
    const parts = data.output[0]?.content ?? [];
    text = parts.map((p) => p.text ?? '').join('');
  } else if (data.choices && data.choices[0]?.message?.content) {
    text = data.choices[0].message.content;
  }
  return text;
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  const jsonText = m ? m[0] : text;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function buildMotivoAnalysisPrompt({ motivo, samples }) {
  // samples: array de objetos { atendimento_id, transcript: [ { role: 'operator'|'customer'|'bot', text } ] }
  const blocks = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const lines = (s.transcript || []).map((m) => {
      const who = m.role === 'operator' ? 'ATENDENTE' : (m.role === 'bot' ? 'BOT' : 'CLIENTE');
      return `${who}: ${m.text}`;
    }).join('\n');
    blocks.push(`==== ATENDIMENTO ${i + 1} | Id=${s.atendimento_id} ====\n${lines}`);
  }

  const guidance = `
Você é um analista especializado. Com base nas transcrições de atendimentos REAIS a seguir, agregue padrões e gere um pacote de CENÁRIO para simulações.

MotivoDeContato (CENÁRIO): ${motivo}

TAREFAS:
1) Proponha um título sucinto para o cenário (scenario_title) que um humano entenda.
2) Liste de 1 a 4 perfis típicos de cliente (customer_profiles) em linguagem natural, ex.: ["Cliente Calmo", "Cliente Irritado"].
3) Descreva de forma objetiva o PROCESSO esperado (process_text) que o atendente deveria seguir (passo a passo resumido, sem dados sensíveis).
4) Liste DIRETRIZES objetivas para o atendente (operator_guidelines) como bullets, ex.: ["Saudar com empatia", "Confirmar dados de segurança"].
5) Extraia PADRÕES recorrentes (patterns) sobre o atendimento ou o cliente, ex.: ["cliente costuma chegar sem documento X", "espera longa para validação"].

FORMATO OBRIGATÓRIO (JSON estrito, sem comentários):
{
  "scenario_title": "string",
  "customer_profiles": ["string", "..."],
  "process_text": "string",
  "operator_guidelines": ["string", "..."],
  "patterns": ["string", "..."]
}
`;

  const body = [
    guidance.trim(),
    'TRANSCRIÇÕES (amostra, mensagens ordenadas):',
    blocks.join('\n\n')
  ].join('\n\n');

  return [{ role: 'user', content: [{ type: 'text', text: truncate(body, LAB_MAX_TRANSCRIPT_CHARS) }] }];
}

/**
 * Inicia o job de análise (não bloqueante).
 */
export async function startLabAnalysis(pgClient, { runId, clientId }) {
  // Executa em background sem bloquear o request, usando microtask para não segurar o loop atual
  setImmediate(async () => {
    let fatal = null;
    try {
      // Sanidade: run ainda existe/pertence ao cliente?
      const rr = await pgClient.query(`SELECT id, status FROM public.lab_runs WHERE id = $1 AND client_id = $2`, [runId, clientId]);
      if (rr.rows.length === 0) {
        return; // nada a fazer
      }

      // Lista motivos e totais
      const mqs = await pgClient.query(
        `SELECT motivo, COUNT(DISTINCT atendimento_id)::int AS total
           FROM public.lab_transcripts_raw
          WHERE run_id = $1 AND client_id = $2
          GROUP BY motivo
          ORDER BY motivo ASC`,
        [runId, clientId]
      );

      for (const row of mqs.rows) {
        const motivo = row.motivo;
        const total = row.total;

        // Estado atual de progresso para este motivo
        const prog = await pgClient.query(
          `SELECT total_ids_distinct, processed_ids_distinct
             FROM public.lab_progress
            WHERE run_id = $1 AND motivo = $2`,
          [runId, motivo]
        );
        let processed = prog.rows.length > 0 ? Number(prog.rows[0].processed_ids_distinct || 0) : 0;

        // Distintos IdAtendimento para iterar
        const idsRes = await pgClient.query(
          `SELECT DISTINCT atendimento_id
             FROM public.lab_transcripts_raw
            WHERE run_id = $1 AND client_id = $2 AND motivo = $3
            ORDER BY atendimento_id`,
          [runId, clientId, motivo]
        );
        const allIds = idsRes.rows.map((r) => r.atendimento_id);

        // Amostra controlada para enviar ao LLM
        const sampleIds = allIds.slice(0, LAB_MAX_SAMPLE_ATT);
        const samples = [];

        for (const atendimentoId of allIds) {
          try {
            const msgs = await pgClient.query(
              `SELECT seq, role_norm, message_text
                 FROM public.lab_transcripts_raw
                WHERE run_id = $1 AND client_id = $2 AND motivo = $3 AND atendimento_id = $4
                ORDER BY seq ASC`,
              [runId, clientId, motivo, atendimentoId]
            );
            if (sampleIds.includes(atendimentoId)) {
              const transcript = msgs.rows.map((m) => ({
                role: m.role_norm, // 'operator' | 'bot' | 'customer'
                text: m.message_text,
              }));
              samples.push({ atendimento_id: atendimentoId, transcript });
            }

            // Marca progresso (contagem por IdAtendimento distinto)
            processed += 1;
            await pgClient.query(
              `UPDATE public.lab_progress
                  SET processed_ids_distinct = $3, updated_at = now()
                WHERE run_id = $1 AND motivo = $2`,
              [runId, motivo, Math.min(processed, total)]
            );
          } catch (perAttErr) {
            // Loga erro por atendimento e continua
            await pgClient.query(
              `INSERT INTO public.lab_errors (run_id, client_id, atendimento_id, motivo, error_code, reason)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [runId, clientId, atendimentoId, motivo, 'ATT_PROCESS_ERR', String(perAttErr?.message || perAttErr)]
            );
          }
        }

        // Chamada única ao LLM por motivo com amostra
        try {
          const messages = buildMotivoAnalysisPrompt({ motivo, samples });
          const aiText = await azureResponses(messages);
          const json = extractJson(aiText);

          if (!json || typeof json !== 'object') {
            throw new Error('Resposta do modelo não é um JSON válido no formato esperado');
          }

          const scenario_title = String(json.scenario_title || motivo).slice(0, 200);
          const customer_profiles = Array.isArray(json.customer_profiles) ? json.customer_profiles : [];
          const process_text = typeof json.process_text === 'string' ? json.process_text : null;
          const operator_guidelines = Array.isArray(json.operator_guidelines) ? json.operator_guidelines : [];
          const patterns = Array.isArray(json.patterns) ? json.patterns : [];

          // Upsert em lab_results
          await pgClient.query(
            `INSERT INTO public.lab_results
              (run_id, client_id, motivo, scenario_title, customer_profiles, process_text, operator_guidelines, patterns, status)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, 'ready')
             ON CONFLICT (run_id, motivo) DO UPDATE
               SET scenario_title = EXCLUDED.scenario_title,
                   customer_profiles = EXCLUDED.customer_profiles,
                   process_text = EXCLUDED.process_text,
                   operator_guidelines = EXCLUDED.operator_guidelines,
                   patterns = EXCLUDED.patterns,
                   status = 'ready',
                   updated_at = now()`,
            [
              runId,
              clientId,
              motivo,
              scenario_title,
              JSON.stringify(customer_profiles),
              process_text,
              JSON.stringify(operator_guidelines),
              JSON.stringify(patterns),
            ]
          );

          // Se motivo 100% processado, grava cache
          const finalProcessed = Math.min(processed, total);
          if (finalProcessed >= total && total > 0) {
            const summary = {
              scenario_title,
              customer_profiles,
              process_text,
              operator_guidelines,
              patterns,
            };
            await pgClient.query(
              `INSERT INTO public.lab_motivos_cache (client_id, motivo, summary)
               VALUES ($1, $2, $3::jsonb)
               ON CONFLICT (client_id, motivo) DO UPDATE
                 SET summary = EXCLUDED.summary,
                     cached_at = now()`,
              [clientId, motivo, JSON.stringify(summary)]
            );
          }
        } catch (motErr) {
          // Erro ao sintetizar motivo -> registra e segue p/ próximo motivo
          await pgClient.query(
            `INSERT INTO public.lab_errors (run_id, client_id, atendimento_id, motivo, error_code, reason)
             VALUES ($1, $2, NULL, $3, $4, $5)`,
            [runId, clientId, motivo, 'MOTIVO_LLM_ERR', String(motErr?.message || motErr)]
          );
        }
      }

      // Conclui run
      await pgClient.query(
        `UPDATE public.lab_runs
            SET status = 'completed', updated_at = now()
          WHERE id = $1 AND client_id = $2`,
        [runId, clientId]
      );
    } catch (err) {
      fatal = err;
      try {
        await pgClient.query(
          `UPDATE public.lab_runs
              SET status = 'failed', updated_at = now()
            WHERE id = $1 AND client_id = $2`,
          [runId, clientId]
        );
      } catch {}
    } finally {
      if (fatal) {
        console.error('[lab_analysis] Fatal error:', fatal);
      }
    }
  });
}

export default { startLabAnalysis };