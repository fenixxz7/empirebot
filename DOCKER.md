# EmpireBot — Deploy com Docker em VPS

Tudo o que você precisa pra subir o bot numa VPS qualquer (Ubuntu/Debian recomendado).

## Pré-requisitos na VPS

```bash
# Instala Docker + Docker Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

## Passo a passo

### 1. Manda o projeto pra VPS

Escolhe um dos jeitos:

**a) via SCP (do seu PC):**
```bash
scp empirebot-docker.zip user@SEU.IP.DA.VPS:~
ssh user@SEU.IP.DA.VPS
unzip empirebot-docker.zip && cd empirebot-docker
```

**b) via git (se você subir o repo num GitHub privado):**
```bash
git clone git@github.com:seu-user/empirebot.git
cd empirebot
```

### 2. Cria o `.env`

```bash
cp .env.example .env
nano .env
```

Preenche os 3 obrigatórios:
- `POSTGRES_PASSWORD` → senha do Postgres (qualquer string forte)
- `ADMIN_PASSWORD` → senha pra logar no painel web (usuário é `admin`)
- `SESSION_SECRET` → string aleatória longa. Gera com:
  ```bash
  openssl rand -hex 32
  ```

Opcionais:
- `APP_PORT` → porta exposta na VPS (padrão `5000`). Use `80` se quiser direto sem nginx.

### 3. Sobe os containers

```bash
docker compose up -d --build
```

Primeira vez demora uns 2-3 minutos (instala deps + compila frontend). As próximas restarts são instantâneas.

### 4. Verifica

```bash
docker compose logs -f app
```

Deve aparecer:
```
[server] listening on http://0.0.0.0:5000
[server] reativando workers de N instância(s)
```

Acesse: `http://SEU.IP.DA.VPS:5000` (ou a porta que você escolheu).

## Comandos úteis

```bash
# Para
docker compose down

# Para + apaga volumes (CUIDADO: apaga o banco)
docker compose down -v

# Atualizar código (depois de git pull / novo zip)
docker compose up -d --build

# Ver logs do app
docker compose logs -f app

# Ver logs do banco
docker compose logs -f db

# Backup do banco (faça periodicamente!)
docker compose exec db pg_dump -U empirebot empirebot > backup_$(date +%F).sql

# Restaurar backup
cat backup.sql | docker compose exec -T db psql -U empirebot empirebot

# Acessar shell do Postgres
docker compose exec db psql -U empirebot empirebot

# Reiniciar só o app (sem o banco)
docker compose restart app
```

## HTTPS / domínio (opcional mas recomendado)

A forma mais fácil é colocar um Caddy ou Nginx na frente. Exemplo com Caddy:

```bash
sudo apt install caddy -y
sudo nano /etc/caddy/Caddyfile
```

Cole:
```
seu-dominio.com {
    reverse_proxy localhost:5000
}
```

```bash
sudo systemctl reload caddy
```

Caddy resolve TLS sozinho via Let's Encrypt — funciona em segundos.

## Estrutura

```
empirebot-docker/
├── Dockerfile              # build multi-stage (frontend + runtime)
├── docker-compose.yml      # app + postgres
├── .dockerignore
├── .env.example            # copie pra .env e edite
├── DOCKER.md               # esse arquivo
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── server/                 # backend Node + Express + TS
├── src/                    # frontend React + Vite
└── shared/                 # tipos compartilhados
```

## Troubleshooting

**`Error: defina ADMIN_PASSWORD no .env`**
Você esqueceu de criar o `.env` ou esqueceu de preencher `ADMIN_PASSWORD`.

**Porta 5000 já em uso na VPS:**
Altere `APP_PORT=8080` no `.env` e suba de novo.

**Banco não persiste depois de `docker compose down`:**
Não use `down -v` — sem o `-v` o volume `empirebot_db` é mantido.

**App reiniciando em loop:**
```bash
docker compose logs app --tail=100
```
Geralmente é DATABASE_URL errado ou senha do Postgres divergindo entre o serviço `db` e o `app`.
