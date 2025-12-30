-- 011_graph_rag_schema.sql
-- Schema para Graph RAG multi-tenant:
-- - kb_nodes: nós (entidades/tópicos/regra etc.) por cliente e tipo (cliente|operador)
-- - kb_edges: arestas entre nós com relação nomeada
-- - kb_chunk_projections: projeções 2D de embeddings de chunks para visualização (scatter)
--
-- Observações:
-- - Este schema é agnóstico de PII; a anonimização será aplicada em serviços de ingestão/extração.
-- - Usa public.update_row_updated_at() definida em 001_init.sql.
-- - Requer 010_rag_kb_schema.sql para FKs em kb_sources/kb_chunks.

BEGIN;

-- Garantir extensão/funções necessárias
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pgcrypto';
  IF NOT FOUND THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END
$$;

-- =========================
-- Tabela: kb_nodes
-- =========================
CREATE TABLE IF NOT EXISTS public.kb_nodes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kb_type TEXT NOT NULL,
  label TEXT NOT NULL,
  node_type TEXT NULL,
  source_id UUID NULL REFERENCES public.kb_sources(id) ON DELETE SET NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kb_nodes_type_chk CHECK (kb_type IN ('cliente','operador'))
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_kb_nodes_updated_at ON public.kb_nodes;
CREATE TRIGGER trg_update_kb_nodes_updated_at
BEFORE UPDATE ON public.kb_nodes
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_kb_nodes_client_type ON public.kb_nodes (client_id, kb_type);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_node_type ON public.kb_nodes (node_type);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_label ON public.kb_nodes (label);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_source ON public.kb_nodes (source_id);

-- =========================
-- Tabela: kb_edges
-- =========================
CREATE TABLE IF NOT EXISTS public.kb_edges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kb_type TEXT NOT NULL,
  src_node_id UUID NOT NULL REFERENCES public.kb_nodes(id) ON DELETE CASCADE,
  dst_node_id UUID NOT NULL REFERENCES public.kb_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kb_edges_type_chk CHECK (kb_type IN ('cliente','operador'))
);

-- Evitar duplicidade de arestas idênticas por escopo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kb_edges_unique_relation'
      AND conrelid = 'public.kb_edges'::regclass
  ) THEN
    ALTER TABLE public.kb_edges
      ADD CONSTRAINT kb_edges_unique_relation
      UNIQUE (client_id, kb_type, src_node_id, dst_node_id, relation);
  END IF;
END
$$;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_kb_edges_updated_at ON public.kb_edges;
CREATE TRIGGER trg_update_kb_edges_updated_at
BEFORE UPDATE ON public.kb_edges
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_kb_edges_client_type ON public.kb_edges (client_id, kb_type);
CREATE INDEX IF NOT EXISTS idx_kb_edges_relation ON public.kb_edges (relation);
CREATE INDEX IF NOT EXISTS idx_kb_edges_src ON public.kb_edges (src_node_id);
CREATE INDEX IF NOT EXISTS idx_kb_edges_dst ON public.kb_edges (dst_node_id);

-- =========================
-- Tabela: kb_chunk_projections (visualização scatter 2D)
-- =========================
CREATE TABLE IF NOT EXISTS public.kb_chunk_projections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chunk_id UUID NOT NULL REFERENCES public.kb_chunks(id) ON DELETE CASCADE,
  algo TEXT NOT NULL DEFAULT 'pca',
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Restringir (chunk_id, algo) único
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kb_chunk_projections_chunk_algo_unique'
      AND conrelid = 'public.kb_chunk_projections'::regclass
  ) THEN
    ALTER TABLE public.kb_chunk_projections
      ADD CONSTRAINT kb_chunk_projections_chunk_algo_unique
      UNIQUE (chunk_id, algo);
  END IF;
END
$$;

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_kb_chunk_projections_algo ON public.kb_chunk_projections (algo);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_projections_chunk ON public.kb_chunk_projections (chunk_id);

COMMIT;

-- Recomendações:
-- - A extração de nós/arestas via LLM deve limitar relações e deduplicar.
-- - Projeções 2D são auxiliares; recalcular ao alterar embeddings (se re-embedding ocorrer).