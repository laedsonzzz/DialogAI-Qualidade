-- Backfill conversation_messages for finalized conversations by distributing timestamps
-- across the interval [started_at, ended_at] based on transcript order.
-- Idempotent: skips conversations that already have any messages persisted.

BEGIN;

-- Ensure prerequisite tables/columns exist (defensive checks are implicit)

-- Insert messages for conversations that:
--  - are finalized (ended_at IS NOT NULL)
--  - have a JSONB transcript array
--  - do not yet have any rows in conversation_messages
WITH finalized AS (
  SELECT c.id,
         c.started_at,
         c.ended_at,
         c.transcript,
         jsonb_array_length(c.transcript) AS total
    FROM public.conversations c
   WHERE c.ended_at IS NOT NULL
     AND c.transcript IS NOT NULL
     AND jsonb_typeof(c.transcript) = 'array'
     AND jsonb_array_length(c.transcript) > 0
     AND NOT EXISTS (
           SELECT 1
             FROM public.conversation_messages m
            WHERE m.conversation_id = c.id
         )
),
expanded AS (
  SELECT f.id AS conversation_id,
         f.started_at,
         f.ended_at,
         f.total,
         elem AS message,
         ord::int AS seq
    FROM finalized f,
         LATERAL jsonb_array_elements(f.transcript) WITH ORDINALITY AS t(elem, ord)
)
INSERT INTO public.conversation_messages (conversation_id, role, content, created_at, seq)
SELECT e.conversation_id,
       e.message->>'role' AS role,
       e.message->>'content' AS content,
       CASE
         WHEN e.total > 1 THEN
           e.started_at + ((e.ended_at - e.started_at) * ((e.seq - 1)::double precision / (e.total - 1)))
         ELSE
           e.started_at
       END AS created_at,
       e.seq
  FROM expanded e
 WHERE (e.message->>'role') IN ('user', 'assistant')
   AND COALESCE(e.message->>'content', '') <> '';

COMMIT;

-- Notes:
-- - For each finalized conversation, this migration fans out transcript entries into conversation_messages.
-- - created_at is linearly distributed from started_at to ended_at according to the message order.
-- - The migration is safe to run multiple times: it skips any conversation that already has messages.
-- - Non-finalized conversations are intentionally ignored.