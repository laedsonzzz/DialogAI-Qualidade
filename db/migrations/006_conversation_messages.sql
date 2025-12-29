-- Conversation messages table to persist per-message entries with timestamps
-- Idempotent migration.

BEGIN;

CREATE TABLE IF NOT EXISTS public.conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq INTEGER
);

-- Index to speed up listing messages by conversation and chronological order
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id_created_at
  ON public.conversation_messages (conversation_id, created_at);

-- Optional index to support stable ordering by sequence when available
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id_seq
  ON public.conversation_messages (conversation_id, seq);

COMMIT;

-- Notes:
-- - Messages are persisted alongside the legacy JSONB transcript for backward compatibility.
-- - For new interactions, insert both the user message (when applicable) and the assistant reply with proper created_at timestamps.
-- - A later migration will backfill messages for finalized conversations distributing timestamps between started_at and ended_at.