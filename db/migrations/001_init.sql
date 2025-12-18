-- Initial schema for DialogAI (Postgres)
-- Applies on first database initialization via docker-entrypoint-initdb.d

-- Ensure required extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigger function to keep updated_at consistent
CREATE OR REPLACE FUNCTION public.update_row_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Knowledge Base table
CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations table
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario TEXT NOT NULL,
  customer_profile TEXT NOT NULL,
  process_id UUID REFERENCES public.knowledge_base(id),
  transcript JSONB DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  csat_score INTEGER,
  feedback JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triggers to auto-update updated_at
DROP TRIGGER IF EXISTS trg_update_knowledge_base_updated_at ON public.knowledge_base;
CREATE TRIGGER trg_update_knowledge_base_updated_at
BEFORE UPDATE ON public.knowledge_base
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

DROP TRIGGER IF EXISTS trg_update_conversations_updated_at ON public.conversations;
CREATE TRIGGER trg_update_conversations_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_knowledge_base_created_at ON public.knowledge_base (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_category ON public.knowledge_base (category);
CREATE INDEX IF NOT EXISTS idx_conversations_process_id ON public.conversations (process_id);
CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON public.conversations (started_at DESC);