-- Migration 002: Add "status" column to knowledge_base and supporting index
-- Safe to re-run: guards against duplicate column/constraint creation

-- Add column "status" with default 'active' if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'knowledge_base'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  END IF;
END
$$;

-- Add CHECK constraint to enforce allowed values if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_base_status_chk'
      AND conrelid = 'public.knowledge_base'::regclass
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD CONSTRAINT knowledge_base_status_chk
      CHECK (status IN ('active', 'archived'));
  END IF;
END
$$;

-- Create index for status filtering (idempotent)
CREATE INDEX IF NOT EXISTS idx_knowledge_base_status
  ON public.knowledge_base (status);