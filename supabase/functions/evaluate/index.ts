import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { transcript, scenario, customerProfile } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
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

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "user", content: evaluationPrompt },
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
      throw new Error("Erro ao comunicar com a IA");
    }

    const data = await response.json();
    let aiResponse = data.choices[0].message.content;

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      aiResponse = jsonMatch[0];
    }

    const evaluation = JSON.parse(aiResponse);

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
