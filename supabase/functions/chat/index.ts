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
    const { messages, scenario, customerProfile, processId } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Fetch process content if processId is provided
    let processContent = "";
    if (processId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      
      const processResponse = await fetch(
        `${supabaseUrl}/rest/v1/knowledge_base?id=eq.${processId}&select=content`,
        {
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
          },
        }
      );

      if (processResponse.ok) {
        const processData = await processResponse.json();
        if (processData && processData.length > 0) {
          processContent = processData[0].content;
        }
      }
    }

    // System prompt based on scenario, customer profile, and process content
    let systemPrompt = `Você é um cliente do Banco Itaú em um cenário de atendimento.

CENÁRIO: ${scenario}
PERFIL DO CLIENTE: ${customerProfile}
${processContent ? `\n--- PROCESSO OPERACIONAL (USE COMO BASE) ---\n${processContent}\n--- FIM DO PROCESSO ---\n` : ""}

INSTRUÇÕES IMPORTANTES:
- Atue como esse cliente específico, mantendo as características emocionais do perfil
- Seja realista e consistente com a situação apresentada${processContent ? " e com o processo operacional fornecido" : ""}
- Responda de forma natural e humana
- Se o perfil for "irritado", demonstre frustração apropriada
- Se o perfil for "calmo", seja educado e paciente
- Se o perfil for "confuso", faça perguntas e demonstre dúvidas
- Não revele que é uma IA
- Mantenha respostas concisas (máximo 3-4 frases)${processContent ? "\n- Base suas expectativas e respostas no processo operacional fornecido acima" : ""}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns instantes." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("Erro ao comunicar com a IA");
    }

    const data = await response.json();
    const aiMessage = data.choices[0].message.content;

    return new Response(
      JSON.stringify({ message: aiMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
