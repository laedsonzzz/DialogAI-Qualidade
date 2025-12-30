-- 009_enable_pgvector.sql
-- Habilita a extensão pgvector para armazenamento de embeddings e busca vetorial.
-- Idempotente: usa CREATE EXTENSION IF NOT EXISTS.
-- Observação: índices IVFFlat serão criados nas migrações de schema específicas (kb_chunks).

DO $$
BEGIN
  -- pgcrypto já foi habilitado em 001, mas garantimos caso ambiente seja novo
  PERFORM 1 FROM pg_extension WHERE extname = 'pgcrypto';
  IF NOT FOUND THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;

  -- Habilitar pgvector
  PERFORM 1 FROM pg_extension WHERE extname = 'vector';
  IF NOT FOUND THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END
$$;

-- Comentários:
-- - A extensão 'vector' permite colunas do tipo VECTOR(dimension).
-- - Índices recomendados: IVFFlat com distância cosine para embeddings textuais.
-- - Após grandes ingestos, é recomendável rodar ANALYZE nas tabelas para otimizar planos.