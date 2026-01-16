-- 012: Laboratório de Cenários (schema)
-- Cria tabelas para upload, processamento, progresso, resultados e cache por motivo de contato
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS

BEGIN;

-- Garantir extensão para gen_random_uuid() (caso não exista)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==========================================
-- Tabela: lab_runs
-- - Representa uma execução de laboratório (upload + análise)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_lab_runs_updated_at ON public.lab_runs;
CREATE TRIGGER trg_update_lab_runs_updated_at
BEFORE UPDATE ON public.lab_runs
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_lab_runs_client ON public.lab_runs (client_id);
CREATE INDEX IF NOT EXISTS idx_lab_runs_status ON public.lab_runs (status);

-- ==========================================
-- Tabela: lab_transcripts_raw
-- - Armazena registros normalizados do CSV/XLSX carregado
-- - Mapeia colunas: IdAtendimento, Message, Role, Ordem, MotivoDeContato
-- - role_raw: 'agent' | 'bot' | 'user'
-- - role_norm: 'operator' (agent), 'bot' (bot), 'customer' (user)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_transcripts_raw (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.lab_runs(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  atendimento_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  seq INT NOT NULL,
  role_raw TEXT NOT NULL CHECK (role_raw IN ('agent','bot','user')),
  role_norm TEXT NOT NULL CHECK (role_norm IN ('operator','bot','customer')),
  message_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para agrupamento/ordenação
CREATE INDEX IF NOT EXISTS idx_lab_tr_raw_run_atend ON public.lab_transcripts_raw (run_id, atendimento_id);
CREATE INDEX IF NOT EXISTS idx_lab_tr_raw_run_atend_seq ON public.lab_transcripts_raw (run_id, atendimento_id, seq);
CREATE INDEX IF NOT EXISTS idx_lab_tr_raw_client_motivo ON public.lab_transcripts_raw (client_id, motivo);

-- (Opcional) Unicidade por run+atendimento+seq para evitar duplicatas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_lab_tr_raw_run_atend_seq'
      AND conrelid = 'public.lab_transcripts_raw'::regclass
  ) THEN
    ALTER TABLE public.lab_transcripts_raw
      ADD CONSTRAINT uq_lab_tr_raw_run_atend_seq UNIQUE (run_id, atendimento_id, seq);
  END IF;
END$$;

-- ==========================================
-- Tabela: lab_progress
-- - Progresso por run e por motivo (distinct IdAtendimento)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.lab_runs(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  motivo TEXT NOT NULL,
  total_ids_distinct INT NOT NULL DEFAULT 0,
  processed_ids_distinct INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade por run+motivo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_lab_progress_run_motivo'
      AND conrelid = 'public.lab_progress'::regclass
  ) THEN
    ALTER TABLE public.lab_progress
      ADD CONSTRAINT uq_lab_progress_run_motivo UNIQUE (run_id, motivo);
  END IF;
END$$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_lab_progress_run ON public.lab_progress (run_id);
CREATE INDEX IF NOT EXISTS idx_lab_progress_client_motivo ON public.lab_progress (client_id, motivo);

-- ==========================================
-- Tabela: lab_results
-- - Resultado agregado por motivo (draft/ready), pronto para revisão/commit
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.lab_runs(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  motivo TEXT NOT NULL,
  scenario_title TEXT NOT NULL,
  customer_profiles JSONB NOT NULL DEFAULT '[]'::jsonb,     -- ex.: ["Cliente Calmo","Cliente Irritado"]
  process_text TEXT NULL,                                   -- texto derivado de processos do atendimento
  operator_guidelines JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ex.: ["Saudar", "Confirmar dados"...]
  patterns JSONB NOT NULL DEFAULT '[]'::jsonb,              -- ex.: ["padrão de espera", "validação X"]
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade por run+motivo (um agregado por motivo em um run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_lab_results_run_motivo'
      AND conrelid = 'public.lab_results'::regclass
  ) THEN
    ALTER TABLE public.lab_results
      ADD CONSTRAINT uq_lab_results_run_motivo UNIQUE (run_id, motivo);
  END IF;
END$$;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_lab_results_updated_at ON public.lab_results;
CREATE TRIGGER trg_update_lab_results_updated_at
BEFORE UPDATE ON public.lab_results
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices
CREATE INDEX IF NOT EXISTS idx_lab_results_run ON public.lab_results (run_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_client_motivo ON public.lab_results (client_id, motivo);

-- ==========================================
-- Tabela: lab_motivos_cache
-- - Cache por client+motivo quando 100% processado, para retomar após falhas
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_motivos_cache (
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  motivo TEXT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb, -- espelha payload de saída (scenario_title, profiles, process_text, guidelines, patterns)
  PRIMARY KEY (client_id, motivo)
);

CREATE INDEX IF NOT EXISTS idx_lab_motivos_cache_cached_at ON public.lab_motivos_cache (cached_at DESC);

-- ==========================================
-- Tabela: lab_errors (opcional para diagnóstico)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.lab_errors (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.lab_runs(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  atendimento_id TEXT NULL,
  motivo TEXT NULL,
  error_code TEXT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_errors_run ON public.lab_errors (run_id);
CREATE INDEX IF NOT EXISTS idx_lab_errors_client ON public.lab_errors (client_id);

COMMIT;