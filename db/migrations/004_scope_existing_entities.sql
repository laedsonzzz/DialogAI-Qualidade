-- Migration 004: Escopo multi-tenant nas entidades existentes
-- - Adiciona client_id à knowledge_base (com backfill) + FK e índices
-- - Adiciona client_id, user_id e prompt_version_id à conversations (com backfill) + FKs e índices
-- - Garante integridade: conversations.client_id deve coincidir com o client_id da knowledge_base referenciada (process_id)
-- - Cria cliente 'default' para backfill de dados legados
--
-- Idempotente por meio de verificações em information_schema e pg_constraint/pg_trigger

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 0) Garantir cliente 'default' para dados existentes
-- ============================================================
INSERT INTO public.clients (id, name, code, created_at, updated_at)
SELECT gen_random_uuid(), 'Default', 'default', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM public.clients WHERE code = 'default');

-- ============================================================
-- 1) knowledge_base: adicionar client_id, backfill, FK, índices
-- ============================================================

-- 1.1 Adicionar coluna client_id (se não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='knowledge_base' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD COLUMN client_id UUID NULL;
  END IF;
END
$$;

-- 1.2 Backfill: setar client_id = default para registros legados
UPDATE public.knowledge_base kb
SET client_id = (SELECT id FROM public.clients WHERE code = 'default')
WHERE kb.client_id IS NULL;

-- 1.3 Tornar NOT NULL (seguro se já estiver)
ALTER TABLE public.knowledge_base
  ALTER COLUMN client_id SET NOT NULL;

-- 1.4 Adicionar FK (se não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_base_client_fk'
      AND conrelid = 'public.knowledge_base'::regclass
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD CONSTRAINT knowledge_base_client_fk
      FOREIGN KEY (client_id)
      REFERENCES public.clients(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 1.5 Índices úteis: (client_id, status) para filtragem por cliente e status
CREATE INDEX IF NOT EXISTS idx_knowledge_base_client ON public.knowledge_base (client_id);
-- status foi criado na 002; criar índice composto:
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='knowledge_base' AND column_name='status'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_knowledge_base_client_status
    ON public.knowledge_base (client_id, status);
  END IF;
END
$$;

-- ============================================================
-- 2) conversations: adicionar client_id, user_id, prompt_version_id
-- ============================================================

-- 2.1 Adicionar colunas (se não existirem)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.conversations
      ADD COLUMN client_id UUID NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='user_id'
  ) THEN
    ALTER TABLE public.conversations
      ADD COLUMN user_id UUID NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='prompt_version_id'
  ) THEN
    ALTER TABLE public.conversations
      ADD COLUMN prompt_version_id UUID NULL;
  END IF;
END
$$;

-- 2.2 Backfill: client_id derivado de knowledge_base via process_id; se process_id é NULL, usar 'default'
UPDATE public.conversations c
SET client_id = kb.client_id
FROM public.knowledge_base kb
WHERE c.process_id IS NOT NULL
  AND c.process_id = kb.id
  AND c.client_id IS NULL;

UPDATE public.conversations c
SET client_id = (SELECT id FROM public.clients WHERE code = 'default')
WHERE c.client_id IS NULL;

-- 2.3 FKs (se não existirem)
-- FK client_id -> clients.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_client_fk'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_client_fk
      FOREIGN KEY (client_id)
      REFERENCES public.clients(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- FK user_id -> users.id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='users' AND relkind='r') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversations_user_fk'
        AND conrelid = 'public.conversations'::regclass
    ) THEN
      ALTER TABLE public.conversations
        ADD CONSTRAINT conversations_user_fk
        FOREIGN KEY (user_id)
        REFERENCES public.users(id)
        ON DELETE SET NULL;
    END IF;
  END IF;
END
$$;

-- FK prompt_version_id -> prompt_versions.id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='prompt_versions' AND relkind='r') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversations_prompt_version_fk'
        AND conrelid = 'public.conversations'::regclass
    ) THEN
      ALTER TABLE public.conversations
        ADD CONSTRAINT conversations_prompt_version_fk
        FOREIGN KEY (prompt_version_id)
        REFERENCES public.prompt_versions(id)
        ON DELETE SET NULL;
    END IF;
  END IF;
END
$$;

-- 2.4 Índices para performance
CREATE INDEX IF NOT EXISTS idx_conversations_client_started_at
  ON public.conversations (client_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON public.conversations (user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_prompt_version_id
  ON public.conversations (prompt_version_id);

-- ============================================================
-- 3) Integridade entre conversations.client_id e knowledge_base.client_id
-- ============================================================

-- Função de trigger: valida que client_id da conversa coincide com o da KB referenciada
CREATE OR REPLACE FUNCTION public.ensure_conversation_client_matches_kb()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  kb_client UUID;
BEGIN
  IF NEW.process_id IS NOT NULL THEN
    SELECT client_id INTO kb_client
    FROM public.knowledge_base
    WHERE id = NEW.process_id;

    IF kb_client IS NULL THEN
      RAISE EXCEPTION 'Processo (% ) não encontrado para validar client_id', NEW.process_id;
    END IF;

    IF NEW.client_id IS NULL THEN
      -- Se client_id não fornecido, herdar da KB
      NEW.client_id := kb_client;
    ELSIF NEW.client_id <> kb_client THEN
      RAISE EXCEPTION 'conversations.client_id (%) deve coincidir com knowledge_base.client_id (%) para process_id (%)',
        NEW.client_id, kb_client, NEW.process_id;
    END IF;
  ELSE
    -- Sem process_id: garantir que client_id não é nulo
    IF NEW.client_id IS NULL THEN
      NEW.client_id := (SELECT id FROM public.clients WHERE code='default');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Criar trigger se não existir
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_conversations_client_kb_integrity'
      AND tgrelid = 'public.conversations'::regclass
  ) THEN
    CREATE TRIGGER trg_conversations_client_kb_integrity
    BEFORE INSERT OR UPDATE OF client_id, process_id
    ON public.conversations
    FOR EACH ROW
    EXECUTE FUNCTION public.ensure_conversation_client_matches_kb();
  END IF;
END
$$;

-- ============================================================
-- Observações finais
-- ============================================================
-- - Todas as consultas a knowledge_base e conversations devem filtrar por client_id
-- - user_id e prompt_version_id permanecem opcionais; novos fluxos irão preenchê-los
-- - A integridade entre client_id da conversa e da KB é reforçada pelo trigger acima