-- Soft delete for conversations: add deleted_at and index
-- This migration is idempotent and safe to run multiple times.

BEGIN;

-- Add column deleted_at to conversations (soft delete marker)
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- Partial index for faster filtering of non-null deleted_at
CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at_notnull
  ON public.conversations (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Optional helper index for listing active (not deleted) by started_at
-- Note: Postgres doesn't support partial + DESC directly, but planner can use existing idx_conversations_started_at
-- If needed, uncomment the following index to optimize common queries filtering by deleted_at IS NULL and ordering by started_at:
-- CREATE INDEX IF NOT EXISTS idx_conversations_active_started_at
--   ON public.conversations (started_at DESC)
--   WHERE deleted_at IS NULL;

COMMIT;

-- Impact:
-- - All listing endpoints should filter conversations with "deleted_at IS NULL".
-- - DELETE action will set "deleted_at = now()" instead of removing rows.
-- - Audit logs should capture soft delete events with optional reason provided by the admin.