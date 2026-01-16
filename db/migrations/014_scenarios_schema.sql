-- 014: Cenários Principais (schema)
-- Cria tabelas para armazenar cenários aprovados e seus perfis
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS

BEGIN;

-- Garantir extensão para gen_random_uuid() (caso não exista)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==========================================
-- Tabela: scenarios
-- - Cenários aprovados (commited) por cliente
-- - Unique por (client_id, motivo_label)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.scenarios (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  motivo_label TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,   -- espaço para padrões, métricas, etc.
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade por cliente + motivo_label
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_scenarios_client_motivo'
      AND conrelid = 'public.scenarios'::regclass
  ) THEN
    ALTER TABLE public.scenarios
      ADD CONSTRAINT uq_scenarios_client_motivo UNIQUE (client_id, motivo_label);
  END IF;
END$$;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_scenarios_updated_at ON public.scenarios;
CREATE TRIGGER trg_update_scenarios_updated_at
BEFORE UPDATE ON public.scenarios
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_scenarios_client ON public.scenarios (client_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_status ON public.scenarios (status);

-- ==========================================
-- Tabela: scenario_profiles
-- - Perfis de cliente associados a um cenário aprovado
-- - Unique (scenario_id, profile_label)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.scenario_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  profile_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade por cenário + perfil
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_scenario_profiles_scenario_label'
      AND conrelid = 'public.scenario_profiles'::regclass
  ) THEN
    ALTER TABLE public.scenario_profiles
      ADD CONSTRAINT uq_scenario_profiles_scenario_label UNIQUE (scenario_id, profile_label);
  END IF;
END$$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_scenario_profiles_scenario ON public.scenario_profiles (scenario_id);

COMMIT;