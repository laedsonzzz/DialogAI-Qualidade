import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import { ProxyAgent, fetch } from 'undici';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*', allowedHeaders: ['authorization', 'x-client-info', 'apikey', 'content-type'] }));
app.use(express.json({ limit: '2mb' }));

// Postgres connection
const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgres://${process.env.POSTGRES_USER || 'dialogai'}:${process.env.POSTGRES_PASSWORD || 'dialogai_secret'}@${process.env.POSTGRES_HOST || 'postgres'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'dialogai'}`;

const pgClient = new Client({ connectionString: DATABASE_URL });

// Azure OpenAI env
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT_1;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY_1;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION_1;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_1;

function assertAzureEnv() {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_DEPLOYMENT) {
    throw new Error('Azure OpenAI environment variables are not configured');
  }
}

// Proxy env (supports uppercase/lowercase)
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

async function azureResponses(messages) {
  assertAzureEnv();
  const url =
    AZURE_OPENAI_ENDPOINT +
    'openai/deployments/' +
    AZURE_OPENAI_DEPLOYMENT +
    '/responses?api-version=' +
    AZURE_OPENAI_API_VERSION;

  const resp = await fetchWithProxy(url, {
    method: 'POST',
    headers: {
      'api-key': AZURE_OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error('Azure OpenAI error:', resp.status, txt);
    const status = resp.status;
    if (status === 429) {
      throw Object.assign(new Error('Limite de requisições excedido.'), { status });
    }
    if (status === 402) {
      throw Object.assign(new Error('Créditos insuficientes.'), { status });
    }
    throw Object.assign(new Error('Erro ao comunicar com a IA'), { status });
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

function buildSystemPrompt({ scenario, customerProfile, processContent }) {
  return `Você é um cliente do Banco Itaú em um cenário de atendimento.

CENÁRIO: ${scenario}
PERFIL DO CLIENTE: ${customerProfile}
${processContent ? `\n--- PROCESSO OPERACIONAL (USE COMO BASE) ---\n${processContent}\n--- FIM DO PROCESSO ---\n` : ''}

INSTRUÇÕES IMPORTANTES:
- Atue como esse cliente específico, mantendo as características emocionais do perfil
- Seja realista e consistente com a situação apresentada${processContent ? ' e com o processo operacional fornecido' : ''}
- Responda de forma natural e humana
- Se o perfil for "irritado", demonstre frustração apropriada
- Se o perfil for "calmo", seja educado e paciente
- Se o perfil for "confuso", faça perguntas e demonstre dúvidas
- Não revele que é uma IA
- Mantenha respostas concisas (máximo 3-4 frases)${processContent ? '\n- Base suas expectativas e respostas no processo operacional fornecido acima' : ''}`;
}

function buildEvaluationPrompt({ transcript, scenario, customerProfile }) {
  const transcriptText = (transcript || [])
    .map((msg) => `${msg.role === 'user' ? 'ATENDENTE' : 'CLIENTE'}: ${msg.content}`)
    .join('\n');

  return `Você é um avaliador especialista em atendimento ao cliente de call center bancário.

CENÁRIO: ${scenario}
PERFIL DO CLIENTE: ${customerProfile}

Analise a conversa abaixo e avalie a qualidade do atendimento do operador.

TRANSCRIÇÃO DA CONVERSA:
${transcriptText}

INSTRUÇÕES:
1. Dê uma nota CSAT de 1 a 5 (1=Péssimo, 5=Excelente)
2. Identifique PONTOS POSITIVOS do atendimento (máximo 3)
3. Identifique OPORTUNIDADES DE MELHORIA (máximo 3)
4. Para cada oportunidade, forneça um EXEMPLO ESPECÍFICO de como o atendente poderia ter respondido melhor, citando a parte exata da conversa

Critérios de avaliação:
- Empatia e acolhimento
- Clareza na comunicação
- Resolutividade
- Tempo de resposta
- Profissionalismo
- Uso de linguagem positiva

FORMATO DA RESPOSTA (JSON):
{
  "csat": número de 1 a 5,
  "pontos_positivos": ["ponto 1", "ponto 2", "ponto 3"],
  "oportunidades": [
    {
      "area": "Nome da área de melhoria",
      "trecho_original": "Trecho exato do que o atendente disse",
      "sugestao": "Como o atendente poderia ter dito"
    }
  ],
  "resumo": "Resumo geral da avaliação em 2-3 frases"
}`;
}

function toAzureMessagesFromChat({ systemPrompt, messages }) {
  const sys = { role: 'system', content: [{ type: 'text', text: systemPrompt }] };
  const userAssistant = (messages || []).map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
  }));
  return [sys, ...userAssistant];
}

// Routes
// Debug: log de todas as requisições para /api
app.use('/api', (req, _res, next) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// Create conversation
app.post('/api/conversations', async (req, res) => {
  try {
    const { scenario, customerProfile, processId } = req.body;
    const result = await pgClient.query(
      `INSERT INTO public.conversations (scenario, customer_profile, transcript, process_id, started_at)
       VALUES ($1, $2, '[]'::jsonb, $3, now()) RETURNING id`,
      [scenario, customerProfile, processId || null]
    );
    return res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error('Create conversation error:', err);
    return res.status(500).json({ error: 'Erro ao iniciar conversa' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, scenario, customerProfile, processId, conversationId } = req.body;

    let processContent = '';
    if (processId) {
      const pr = await pgClient.query('SELECT content FROM public.knowledge_base WHERE id = $1', [processId]);
      if (pr.rows.length > 0) {
        processContent = pr.rows[0].content;
      }
    }

    const systemPrompt = buildSystemPrompt({ scenario, customerProfile, processContent });
    const azureMessages = toAzureMessagesFromChat({ systemPrompt, messages });
    const aiMessageText = await azureResponses(azureMessages);

    // persist transcript if conversationId provided
    if (conversationId) {
      const finalMessages = [...(messages || []), { role: 'assistant', content: aiMessageText }];
      await pgClient.query('UPDATE public.conversations SET transcript = $2::jsonb WHERE id = $1', [
        conversationId,
        JSON.stringify(finalMessages),
      ]);
    }

    return res.json({ message: aiMessageText });
  } catch (err) {
    console.error('Chat error:', err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'Erro desconhecido' });
  }
});

// Evaluate endpoint
app.post('/api/evaluate', async (req, res) => {
  try {
    const { transcript, scenario, customerProfile, conversationId } = req.body;

    const evaluationPrompt = buildEvaluationPrompt({ transcript, scenario, customerProfile });
    const messages = [{ role: 'user', content: [{ type: 'text', text: evaluationPrompt }] }];
    const aiText = await azureResponses(messages);

    // Extract JSON from response (handle markdown)
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : aiText;
    const evaluation = JSON.parse(jsonText);

    // persist evaluation if conversationId
    if (conversationId) {
      await pgClient.query(
        `UPDATE public.conversations
         SET ended_at = now(),
             csat_score = $2,
             feedback = $3::jsonb
         WHERE id = $1`,
        [conversationId, evaluation.csat || null, JSON.stringify(evaluation)]
      );
    }

    return res.json(evaluation);
  } catch (err) {
    console.error('Evaluate error:', err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message || 'Erro ao avaliar conversa',
      csat: 3,
      pontos_positivos: ['Não foi possível gerar avaliação completa'],
      oportunidades: [],
      resumo: 'Ocorreu um erro ao processar a avaliação.',
    });
  }
});

// Knowledge base CRUD
app.get('/api/knowledge_base', async (_req, res) => {
  try {
    const r = await pgClient.query('SELECT id, title, category, content, created_at, updated_at FROM public.knowledge_base ORDER BY created_at DESC');
    return res.json(r.rows);
  } catch (err) {
    console.error('KB list error:', err);
    return res.status(500).json({ error: 'Erro ao carregar processos' });
  }
});

app.post('/api/knowledge_base', async (req, res) => {
  try {
    const { title, category, content } = req.body;
    await pgClient.query(
      `INSERT INTO public.knowledge_base (title, category, content) VALUES ($1, $2, $3)`,
      [title, category, content]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('KB insert error:', err);
    return res.status(500).json({ error: 'Erro ao salvar processo' });
  }
});

app.delete('/api/knowledge_base/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pgClient.query('DELETE FROM public.knowledge_base WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('KB delete error:', err);
    return res.status(500).json({ error: 'Erro ao excluir processo' });
  }
});

// Serve frontend (Vite build output in dist)
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Boot
(async () => {
  try {
    await pgClient.connect();
    console.log('Connected to Postgres');
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      if (PROXY_URL) {
        console.log(`HTTP(S) proxy enabled: ${PROXY_URL}`);
      } else {
        console.log('HTTP(S) proxy disabled');
      }
      const noProxyEnv = process.env.NO_PROXY || process.env.no_proxy;
      if (noProxyEnv) {
        console.log(`NO_PROXY=${noProxyEnv}`);
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();