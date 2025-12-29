-- 008_user_avatars.sql
-- Armazena avatar do usuário diretamente no Postgres (bytea), com tipo e limite de tamanho
-- Requisitos:
--  - Tipos permitidos: image/jpeg, image/png
--  - Tamanho máximo: 2 MB
--  - Resize/crop será aplicado no backend antes de persistir (256x256)

CREATE TABLE IF NOT EXISTS public.user_avatars (
  user_id UUID PRIMARY KEY
    REFERENCES public.users (id)
    ON DELETE CASCADE,
  content BYTEA NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Limite de 2 MB
  CONSTRAINT user_avatars_max_size CHECK (octet_length(content) <= 2097152)
);

COMMENT ON TABLE public.user_avatars IS 'Avatar do usuário armazenado como bytea (256x256), com content_type e updated_at.';
COMMENT ON COLUMN public.user_avatars.user_id IS 'ID do usuário (PK e FK para users.id).';
COMMENT ON COLUMN public.user_avatars.content IS 'Conteúdo binário do avatar em formato JPEG ou PNG, recortado e redimensionado para 256x256.';
COMMENT ON COLUMN public.user_avatars.content_type IS 'MIME type do avatar (image/jpeg ou image/png).';
COMMENT ON COLUMN public.user_avatars.updated_at IS 'Data/hora da última atualização do avatar.';