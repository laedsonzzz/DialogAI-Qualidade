-- Migration 003: Auth, Multi-tenant, RBAC, Prompts versionados e Auditoria
-- Esta migração cria:
-- - clients
-- - employees
-- - users
-- - user_clients (permissões por cliente)
-- - user_employee_links (vínculo usuário-matrícula por cliente)
-- - prompts / prompt_versions
-- - audit_log
-- - login_history
--
-- Observações:
-- - Usa public.update_row_updated_at() definida em 001_init.sql
-- - Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS

-- Garantir extensão para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================
-- Tabela: clients
-- =========================
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_clients_updated_at ON public.clients;
CREATE TRIGGER trg_update_clients_updated_at
BEFORE UPDATE ON public.clients
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices adicionais (úteis para buscas)
CREATE INDEX IF NOT EXISTS idx_clients_name ON public.clients (name);

-- =========================
-- Tabela: employees (funcionários por cliente)
-- =========================
CREATE TABLE IF NOT EXISTS public.employees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  matricula TEXT NOT NULL,
  nome TEXT NOT NULL,
  matricula_supervisor TEXT NULL,
  supervisor TEXT NULL,
  funcao TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, matricula)
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_employees_updated_at ON public.employees;
CREATE TRIGGER trg_update_employees_updated_at
BEFORE UPDATE ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_employees_client ON public.employees (client_id);
CREATE INDEX IF NOT EXISTS idx_employees_client_funcao ON public.employees (client_id, funcao);
CREATE INDEX IF NOT EXISTS idx_employees_client_matricula_supervisor ON public.employees (client_id, matricula_supervisor);

-- =========================
-- Tabela: users (contas de acesso)
-- =========================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  password_hash TEXT NULL,
  must_reset_password BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_status_chk CHECK (status IN ('active','inactive'))
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_users_updated_at ON public.users;
CREATE TRIGGER trg_update_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índices adicionais
CREATE INDEX IF NOT EXISTS idx_users_status ON public.users (status);

-- =========================
-- Tabela: user_clients (associação usuário-cliente com permissões)
-- =========================
CREATE TABLE IF NOT EXISTS public.user_clients (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  tipo_usuario TEXT NOT NULL DEFAULT 'interno',
  can_start_chat BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_kb BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_team_chats BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_all_client_chats BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id),
  CONSTRAINT user_clients_tipo_chk CHECK (tipo_usuario IN ('interno','externo'))
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_user_clients_updated_at ON public.user_clients;
CREATE TRIGGER trg_update_user_clients_updated_at
BEFORE UPDATE ON public.user_clients
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

-- Índice para consultas por cliente
CREATE INDEX IF NOT EXISTS idx_user_clients_client ON public.user_clients (client_id);

-- =========================
-- Tabela: user_employee_links (vínculo usuário & matrícula por cliente)
-- =========================
CREATE TABLE IF NOT EXISTS public.user_employee_links (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  matricula TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

-- FK opcional (se matricula informada, aponta para employees)
-- Para idempotência e garantia de existência do índice UNIQUE em employees (client_id, matricula), criamos constraint nomeada com guarda:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_employee_links_employee_fk'
  ) THEN
    ALTER TABLE public.user_employee_links
    ADD CONSTRAINT user_employee_links_employee_fk
    FOREIGN KEY (client_id, matricula)
    REFERENCES public.employees (client_id, matricula)
    ON UPDATE NO ACTION
    ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_user_employee_links_employee ON public.user_employee_links (client_id, matricula);

-- =========================
-- Tabela: prompts (por cliente)
-- =========================
CREATE TABLE IF NOT EXISTS public.prompts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_update_prompts_updated_at ON public.prompts;
CREATE TRIGGER trg_update_prompts_updated_at
BEFORE UPDATE ON public.prompts
FOR EACH ROW
EXECUTE FUNCTION public.update_row_updated_at();

CREATE INDEX IF NOT EXISTS idx_prompts_client ON public.prompts (client_id);

-- =========================
-- Tabela: prompt_versions (versionamento de prompt)
-- =========================
CREATE TABLE IF NOT EXISTS public.prompt_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  prompt_id UUID NOT NULL REFERENCES public.prompts(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);

-- Apenas uma versão ativa por prompt (índice parcial único)
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_versions_active
ON public.prompt_versions (prompt_id)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt_active ON public.prompt_versions (prompt_id, is_active);

-- =========================
-- Tabela: audit_log (auditoria de alterações)
-- =========================
CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before JSONB NULL,
  after JSONB NULL,
  ip TEXT NULL,
  user_agent TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_client_created ON public.audit_log (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log (entity_type, entity_id);

-- =========================
-- Tabela: login_history (histórico de login)
-- =========================
CREATE TABLE IF NOT EXISTS public.login_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL,
  reason TEXT NULL,
  ip TEXT NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_history_user_ts ON public.login_history (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_client_ts ON public.login_history (client_id, ts DESC);

-- =========================
-- Comentários finais
-- =========================
-- Após esta migração:
-- - Usuários podem ser associados a múltiplos clientes com permissões específicas via public.user_clients
-- - Hierarquia para visibilidade de chats usará public.employees (matricula_supervisor) por client_id
-- - Prompts versionados por cliente via public.prompts e public.prompt_versions
-- - Auditoria e histórico de login prontos para middlewares/rotas