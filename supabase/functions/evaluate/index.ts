/* @ts-nocheck */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { transcript, scenario, customerProfile } = await req.json();
    
    const AZURE_OPENAI_ENDPOINT = Deno.env.get("AZURE_OPENAI_ENDPOINT_1");
    const AZURE_OPENAI_API_KEY = Deno.env.get("AZURE_OPENAI_API_KEY_1");
    const AZURE_OPENAI_API_VERSION = Deno.env.get("AZURE_OPENAI_API_VERSION_1");
    const AZURE_OPENAI_DEPLOYMENT = Deno.env.get("AZURE_OPENAI_DEPLOYMENT_NAME_1");
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_VERSION || !AZURE_OPENAI_DEPLOYMENT) {
      throw new Error("Azure OpenAI environment variables are not configured");
    }

    // System prompt for evaluation
    const evaluationPrompt = `Você é um avaliador especialista em atendimento ao cliente de call center bancário.

CENÁRIO: ${scenario}
PERFIL DO CLIENTE: ${customerProfile}

Analise a conversa abaixo e avalie a qualidade do atendimento do operador.

TRANSCRIÇÃO DA CONVERSA:
${transcript.map((msg: any) => `${msg.role === 'user' ? 'ATENDENTE' : 'CLIENTE'}: ${msg.content}`).join('\n')}

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

    const url = AZURE_OPENAI_ENDPOINT + "openai/deployments/" + AZURE_OPENAI_DEPLOYMENT + "/responses?api-version=" + AZURE_OPENAI_API_VERSION;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": AZURE_OPENAI_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: evaluationPrompt }] },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("Azure OpenAI error:", response.status, errorText);
      throw new Error("Erro ao comunicar com a IA");
    }

    const data = await response.json();
    // Extrai texto da resposta do Azure Responses API
    let aiText = "";
    if (data.output_text && typeof data.output_text === "string") {
      aiText = data.output_text;
    } else if (Array.isArray(data.output) && data.output.length > 0) {
      const contentParts = data.output[0]?.content ?? [];
      aiText = contentParts.map((p: any) => p.text ?? "").join("");
    } else if (data.choices && data.choices[0]?.message?.content) {
      // Fallback de compatibilidade
      aiText = data.choices[0].message.content;
    }

    // Extrai JSON da resposta (suporta blocos markdown)
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : aiText;

    const evaluation = JSON.parse(jsonText);

    return new Response(
      JSON.stringify(evaluation),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Evaluation error:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Erro ao avaliar conversa",
        csat: 3,
        pontos_positivos: ["Não foi possível gerar avaliação completa"],
        oportunidades: [],
        resumo: "Ocorreu um erro ao processar a avaliação."
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
