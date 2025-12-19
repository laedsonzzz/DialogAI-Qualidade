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

# Fluxo completo (git pull + down + up --build)
deploy: pull down rebuild
