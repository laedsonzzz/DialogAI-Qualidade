.PHONY: pull down up rebuild deploy

# Atualiza o repositório
pull:
	git pull

# Derruba os containers e volumes
down:
	docker compose down -v

# Sobe os containers
up:
	docker compose up -d

# Sobe os containers reconstruindo as imagens
rebuild:
	docker compose up -d --build

migrations:
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/001_init.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/002_add_status_to_knowledge_base.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/003_auth_multi_tenant.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/004_scope_existing_entities.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/005_admin_and_rbac.sql     
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/006_conversation_messages.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/007_backfill_conversation_messages.sql
	docker exec -i dialogai_postgres psql -U dialogai -d dialogai -f /docker-entrypoint-initdb.d/008_user_avatars.sql

# Fluxo completo (git pull + down + up --build)
deploy: pull down rebuild
