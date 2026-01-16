-- 015: Permitir múltiplos cenários ativos por motivo_label
-- Remove a restrição UNIQUE (client_id, motivo_label) e mantém índice não único para performance.

BEGIN;

-- Remover a UNIQUE constraint se existir
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_scenarios_client_motivo'
      AND conrelid = 'public.scenarios'::regclass
  ) THEN
    ALTER TABLE public.scenarios
      DROP CONSTRAINT uq_scenarios_client_motivo;
  END IF;
END$$;

-- Criar índice não único para consultas por cliente e motivo_label
CREATE INDEX IF NOT EXISTS idx_scenarios_client_motivo
  ON public.scenarios (client_id, motivo_label);

COMMIT;