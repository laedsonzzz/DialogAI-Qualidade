-- 010_rag_kb_schema.sql
-- Schema RAG multi-tenant:
-- - kb_sources: fontes por cliente e tipo (cliente|operador), documento ou texto livre
-- - kb_chunks: chunks com embeddings pgvector e metadados
-- Índices:
-- - Btrees para filtros por client_id/kb_type/source_id
-- - IVFFlat (cosine) em kb_chunks.embedding com lists=100
--
-- Observações:
-- - Dimensão de embedding definida como 1536 (Azure text-embedding-3-small).
--   Caso deseje alterar, crie uma migração para ajustar o tipo VECTOR(dimension).
-- - Requer extensão 'vector' já habilitada (ver 009_enable_pgvector.sql).
-- - Usa public.update_row_updated_at() definida em 001_init.sql.

BEGIN;

-- Garantir funções/extension necessárias
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pgcrypto';
  IF NOT FOUND THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;

  PERFORM 1 FROM pg_extension WHERE extname = 'vector';
  IF NOT FOUND THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END
$$;

-- =========================
-- Tabela: kb_sources
-- =========================
CREATE TABLE IF NOT EXISTS public.kb_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kb_type TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  original_filename TEXT NULL,
  mime_type TEXT NULL,
  size_bytes INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kb_sources_type_chk CHECK (kb_type IN ('cliente','operador')),
  CONSTRAINT kb_sources_kind_chk CHECK (source_kind IN ('document','free_text')),
  CONSTRAINT kb_sources_status_chk CHECK (status IN ('active','archived'))
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_kb_sources_updated_at ON public.kb_sources;
CREATE TRIGGER trg_update_kb_sources_updated_at
BEFORE UPDATE ON public.kb_sources
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_kb_sources_client ON public.kb_sources (client_id);
CREATE INDEX IF NOT EXISTS idx_kb_sources_client_type ON public.kb_sources (client_id, kb_type);
CREATE INDEX IF NOT EXISTS idx_kb_sources_status ON public.kb_sources (status);
CREATE INDEX IF NOT EXISTS idx_kb_sources_created_by ON public.kb_sources (created_by);

-- =========================
-- Tabela: kb_chunks
-- =========================
CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES public.kb_sources(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kb_type TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NULL,
  embedding VECTOR(1536) NULL, -- Azure text-embedding-3-small
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kb_chunks_type_chk CHECK (kb_type IN ('cliente','operador'))
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_kb_chunks_updated_at ON public.kb_chunks;
CREATE TRIGGER trg_update_kb_chunks_updated_at
BEFORE UPDATE ON public.kb_chunks
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices btree
CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON public.kb_chunks (source_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_client_type ON public.kb_chunks (client_id, kb_type);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_chunk_no ON public.kb_chunks (chunk_no);

-- Índice vetorial IVFFlat (cosine) com lists=100
-- Observação: IVFFlat exige que a tabela tenha sido populada (não é obrigatório, mas melhora performance após ANALYZE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_kb_chunks_embedding_ivfflat'
  ) THEN
    CREATE INDEX idx_kb_chunks_embedding_ivfflat
      ON public.kb_chunks
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END
$$;

-- Integridade adicional: garantir client_id/kb_type de kb_chunks herdam de kb_sources
CREATE OR REPLACE FUNCTION public.ensure_kb_chunks_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  src_client UUID;
  src_type TEXT;
BEGIN
  SELECT s.client_id, s.kb_type INTO src_client, src_type
  FROM public.kb_sources s
  WHERE s.id = NEW.source_id;

  IF src_client IS NULL OR src_type IS NULL THEN
    RAISE EXCEPTION 'Fonte KB (% ) não encontrada para validar consistência', NEW.source_id;
  END IF;

  -- Herdar client_id/kb_type se não informados
  IF NEW.client_id IS NULL THEN
    NEW.client_id := src_client;
  ELSIF NEW.client_id <> src_client THEN
    RAISE EXCEPTION 'kb_chunks.client_id (%) deve coincidir com kb_sources.client_id (%) para source_id (%)',
      NEW.client_id, src_client, NEW.source_id;
  END IF;

  IF NEW.kb_type IS NULL THEN
    NEW.kb_type := src_type;
  ELSIF NEW.kb_type <> src_type THEN
    RAISE EXCEPTION 'kb_chunks.kb_type (%) deve coincidir com kb_sources.kb_type (%) para source_id (%)',
      NEW.kb_type, src_type, NEW.source_id;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_kb_chunks_consistency'
      AND tgrelid = 'public.kb_chunks'::regclass
  ) THEN
    CREATE TRIGGER trg_kb_chunks_consistency
    BEFORE INSERT OR UPDATE OF client_id, kb_type, source_id
    ON public.kb_chunks
    FOR EACH ROW
    EXECUTE FUNCTION public.ensure_kb_chunks_consistency();
  END IF;
END
$$;

COMMIT;

-- Recomendações pós-ingestão:
-- - Rodar ANALYZE public.kb_chunks para otimizar planos do índice IVFFlat.
-- - Ajustar "lists" do índice conforme volume (padrão aceito: 100; pode aumentar para bases muito grandes).