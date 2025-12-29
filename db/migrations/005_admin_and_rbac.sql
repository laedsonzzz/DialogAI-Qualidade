-- 005: Admin flag, RBAC constraints hardening, and performance indexes
-- This migration complements existing multi-tenant and RBAC schema (003/004).

BEGIN;

-- 1) Add admin flag to users (controls access to /api/admin/* endpoints)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Ensure clients.code is normalized and unique
-- 2.1 Enforce NOT NULL for code (requires existing rows to have code; adjust if necessary)
ALTER TABLE public.clients
  ALTER COLUMN code SET NOT NULL;

-- 2.2 Add a normalization trigger to store code in lowercase and trimmed form
CREATE OR REPLACE FUNCTION public.enforce_clients_code_lowercase()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code IS NOT NULL THEN
    NEW.code := lower(trim(NEW.code));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clients_code_lowercase ON public.clients;
CREATE TRIGGER trg_clients_code_lowercase
BEFORE INSERT OR UPDATE ON public.clients
FOR EACH ROW
EXECUTE FUNCTION public.enforce_clients_code_lowercase();

-- 2.3 Unique constraint on clients.code (case-insensitive because we normalize to lower)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'clients_code_unique'
           AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_code_unique UNIQUE (code);
  END IF;
END$$;

-- 3) Ensure user_clients has a unique pair (user_id, client_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'user_clients_user_id_client_id_unique'
           AND conrelid = 'public.user_clients'::regclass
  ) THEN
    ALTER TABLE public.user_clients
      ADD CONSTRAINT user_clients_user_id_client_id_unique UNIQUE (user_id, client_id);
  END IF;
END$$;

-- 4) Employees constraints and indexes (for hierarchy/team queries)
-- Ensure uniqueness of matricula per client
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'employees_client_id_matricula_unique'
           AND conrelid = 'public.employees'::regclass
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_client_id_matricula_unique UNIQUE (client_id, matricula);
  END IF;
END$$;

-- Index to accelerate team visibility queries by supervisor
CREATE INDEX IF NOT EXISTS idx_employees_client_supervisor
  ON public.employees (client_id, matricula_supervisor);

-- 5) user_employee_links indexes (link user to employee matricula per client)
CREATE INDEX IF NOT EXISTS idx_user_employee_links_user_client
  ON public.user_employee_links (user_id, client_id);

-- 6) Conversations indices for RBAC-scoped listing
CREATE INDEX IF NOT EXISTS idx_conversations_client_user
  ON public.conversations (client_id, user_id);

COMMIT;