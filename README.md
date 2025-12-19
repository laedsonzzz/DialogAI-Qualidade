# DialogAI Qualidade — Infra Docker com Postgres e Azure OpenAI

Este projeto foi migrado para uma arquitetura com backend próprio (Node/Express) e banco Postgres via Docker, garantindo persistência de dados e centralização de segredos em .env. As chamadas de LLM foram substituídas para Azure OpenAI Responses API (gpt-4o-mini, 2024-08-01-preview).

Arquitetura
- App (Express + Vite build): [server/index.js](server/index.js)
- Banco de dados: Postgres com volume persistente (pgdata)
- Migrações: aplicadas automaticamente no primeiro start via [db/migrations/001_init.sql](db/migrations/001_init.sql:1)
- Orquestração: [docker-compose.yml](docker-compose.yml:1)
- Frontend: Vite React consumindo API do app com base configurável (VITE_API_BASE_URL)

1. Requisitos
- Docker e Docker Compose instalados
- Node.js (opcional para desenvolvimento local; o build do frontend e a API rodam no container)

2. Configuração de ambiente
Crie o arquivo .env na raiz a partir de [.env.example](.env.example:1):

- Frontend
  - VITE_API_BASE_URL=http://localhost:3000

- Azure OpenAI
  - AZURE_OPENAI_ENDPOINT_1=https://inqualidademiniaec.openai.azure.com/
  - AZURE_OPENAI_API_KEY_1=your_azure_key_here
  - AZURE_OPENAI_API_VERSION_1=2024-08-01-preview
  - AZURE_OPENAI_DEPLOYMENT_NAME_1=gpt-4o-mini

- Postgres (Docker Compose)
  - POSTGRES_DB=dialogai
  - POSTGRES_USER=dialogai
  - POSTGRES_PASSWORD=dialogai_secret

- Conexão usada pelo app (container) para acessar o Postgres (host interno "postgres")
  - DATABASE_URL=postgres://dialogai:dialogai_secret@postgres:5432/dialogai

- App server
  - PORT=3000

Segurança
- [.gitignore](.gitignore:25) já ignora .env
- Nunca versione chaves/segredos; utilize .env e variáveis do Compose

3. Subir a stack com Docker Compose
Na raiz do projeto:

- Build e subir os serviços:
  - docker compose up -d --build

- Verificar logs:
  - docker compose logs -f app
  - docker compose logs -f postgres

- Parar os serviços:
  - docker compose down

Persistência
- O serviço postgres usa volume nomeado pgdata: persistência garantida entre reinícios
- Para remover tudo (incluindo dados), execute:
  - docker compose down -v

4. Migrações de banco (aplicação automática)
No primeiro start do Postgres, o Docker monta [db/migrations](db/migrations/001_init.sql:1) em docker-entrypoint-initdb.d e executa:
- Tabelas:
  - knowledge_base: title, category, content, created_at, updated_at
  - conversations: scenario, customer_profile, process_id (FK em knowledge_base.id), transcript (jsonb), started_at/ended_at, csat_score, feedback (jsonb)
- Triggers de updated_at: [public.update_row_updated_at()](db/migrations/001_init.sql:8)
- Índices úteis para consultas

5. Endpoints da API (Express)
A API do backend está implementada em [server/index.js](server/index.js:1):

- Conversas
  - POST /api/conversations
    - Body: { scenario, customerProfile, processId? }
    - Resposta: { id }
  - POST /api/chat
    - Body: { messages: Message[], scenario, customerProfile, processId?, conversationId? }
    - Integra Azure Responses API para gerar a resposta; se conversationId for informado, persiste transcript
    - Resposta: { message: string }
  - POST /api/evaluate
    - Body: { transcript: Message[], scenario, customerProfile, conversationId? }
    - Integra Azure Responses API para avaliação (JSON); se conversationId for informado, atualiza ended_at, csat_score, feedback
    - Resposta: JSON da avaliação

- Base de Conhecimento
  - GET /api/knowledge_base
    - Lista entradas
  - POST /api/knowledge_base
    - Body: { title, category, content }
  - DELETE /api/knowledge_base/:id
    - Remove entrada por id

6. Integração com Azure OpenAI
- A chamada para Azure Responses é feita via [fetchWithProxy()](server/index.js) usando undici [ProxyAgent](server/index.js) quando HTTP(S) proxy está configurado; caso contrário, utiliza [fetch()](server/index.js). Os headers incluem ["api-key"](server/index.js).
- URL construída como: {AZURE_OPENAI_ENDPOINT_1}/openai/deployments/{AZURE_OPENAI_DEPLOYMENT_NAME_1}/responses?api-version={AZURE_OPENAI_API_VERSION_1}
- Parsing robusto da resposta:
  - Prioriza output_text
  - Fallback em output[0].content[].text
  - Compatibilidade com choices[0].message.content

6.1 Proxy corporativo
- O backend utiliza [fetchWithProxy()](server/index.js) com undici [ProxyAgent](server/index.js) para respeitar variáveis de proxy corporativo:
  - Detecta automaticamente: HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy
  - Respeita NO_PROXY (bypass de proxy para hosts listados). Ex.: "localhost,127.0.0.1,::1,postgres"
  - Loga na inicialização se o proxy está ativo e qual URL foi detectada
- Configuração recomendada (já presente em [docker-compose.yml](docker-compose.yml)):
  - environment:
    - HTTP_PROXY=http://seu.proxy:8080
    - HTTPS_PROXY=http://seu.proxy:8080
    - NO_PROXY=localhost,127.0.0.1,::1,postgres
  - Não adicione o domínio do Azure OpenAI em NO_PROXY para garantir que as chamadas ao Azure passem pelo proxy.
- Execução local sem Docker (opcional):
  - Exportar variáveis de ambiente antes de iniciar:
    - Windows (PowerShell):
      - $env:HTTP_PROXY="http://seu.proxy:8080"; $env:HTTPS_PROXY="http://seu.proxy:8080"; $env:NO_PROXY="localhost,127.0.0.1,::1,postgres"
    - Linux/macOS (bash):
      - export HTTP_PROXY="http://seu.proxy:8080" HTTPS_PROXY="http://seu.proxy:8080" NO_PROXY="localhost,127.0.0.1,::1,postgres"
- Comportamento:
  - Se PROXY_URL estiver definido, o dispatcher é criado via [new ProxyAgent(PROXY_URL)](server/index.js) e aplicado automaticamente nas requisições de saída para o Azure, exceto quando o host está em NO_PROXY.

7. Frontend
- O frontend foi refatorado para consumir os endpoints do app:
  - [src/components/ChatInterface.tsx](src/components/ChatInterface.tsx:1)
    - Usa API_BASE = import.meta.env.VITE_API_BASE_URL
    - POST /api/conversations, POST /api/chat, POST /api/evaluate
  - [src/components/KnowledgeBaseManager.tsx](src/components/KnowledgeBaseManager.tsx:1)
    - GET/POST/DELETE /api/knowledge_base

8. Remoção de Supabase
- Removidos:
  - [src/integrations/supabase/](src/integrations/supabase/client.ts:1)
  - Dependência "@supabase/supabase-js" em [package.json](package.json:42)
- Agora toda persistência é feita no Postgres via API própria

9. Execução local sem Docker (opcional)
- Instale dependências: npm ci
- Build do frontend: npm run build
- Configure DATABASE_URL no .env apontando para um Postgres acessível
- Start do backend: npm start
- Acesse http://localhost:3000

10. Backup/Restaurar dados (volume pgdata)
- Backup do volume (exemplo):
  - docker run --rm -v dialogai_pgdata:/data -v ${PWD}:/backup alpine tar czf /backup/pgdata.tar.gz -C /data .
- Restore (exemplo):
  - docker run --rm -v dialogai_pgdata:/data -v ${PWD}:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/pgdata.tar.gz -C /data"

11. Troubleshooting
- Erro ao conectar no Postgres:
  - Verifique DATABASE_URL e se o serviço postgres está saudável (healthcheck)
- Azure OpenAI erro 429/402:
  - Limite de requisições/créditos insuficientes; revise a chave/planos
- CORS:
  - O app habilita CORS com headers padrão (authorization, x-client-info, apikey, content-type)

12. Licença
- Uso interno para simulações de atendimento e avaliação de qualidade.