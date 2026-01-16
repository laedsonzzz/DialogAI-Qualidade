-- 013: RBAC - Permissão can_manage_scenarios em user_clients
-- Adiciona flag para controlar acesso ao Laboratório de Cenários
-- Idempotente: ADD COLUMN IF NOT EXISTS

BEGIN;

ALTER TABLE public.user_clients
  ADD COLUMN IF NOT EXISTS can_manage_scenarios BOOLEAN NOT NULL DEFAULT FALSE;

-- Opcional: índice para consultas futuras (não estritamente necessário)
-- CREATE INDEX IF NOT EXISTS idx_user_clients_manage_scenarios ON public.user_clients (can_manage_scenarios);

COMMIT;