# EmpireBot — Painel de Controle

Selfbot para Discord que automatiza entrada em filas de apostas (Free Fire, etc.).
Inclui painel web completo com 3 interfaces distintas, controle por instância, rotação de tokens, blacklist automática, DM Responder e estatísticas.

---

## Visão Geral das 3 Interfaces

O sistema tem **3 páginas/sites** diferentes, todas acessíveis no mesmo domínio/porta:

---

### 1. Painel de Controle — `/`

> Página principal. Aqui você gerencia o bot.

**O que tem:**
- **Ligar / Desligar** o bot por instância (BOT1, BOT2…)
- **Stats em tempo real**: Entradas, Na Fila, Partidas, DMs, Bloqueadas, **Msgs Enviadas**
- **Configuração completa**: categorias, modos, delays, valor máximo, tokens, orgs selecionadas
- **Mensagens de partida**: mensagem global + mensagem por org (suporta variáveis como `{adversary_mention}`)
- **Blacklist de orgs por token**: orgs onde o token levou castigo (403) são ignoradas automaticamente. Painel mostra quais e permite desbloquear
- **Erros de envio de mensagem**: contador de falhas de envio (HTTP 400, etc.) por org
- **Logs ao vivo**: console colorido INFO/WARN/ERROR com filtro por origem (engine, match, dm, gateway)
- **Export / Import** de configuração completa em JSON (backup / migração entre VPS)

---

### 2. DM Responder — `/messages`

> Respondedor automático de Message Requests do Discord.

**Acesse por:** `http://SEU_IP:5000/messages`

**O que faz:**
- Monitora a caixa de **Message Requests** de cada token conectado a cada ~60 segundos
- Quando chega um request novo (alguém que quer falar com o bot), responde automaticamente com as mensagens configuradas
- Suporta **sequência de mensagens** por instância (ex: Mensagem 1 → aguarda X segundos → Mensagem 2 → ...)
- Delay configurável entre mensagens e entre usuários (anti-ban)
- Contador: **Hoje** e **Total** de requests respondidos
- Fila ao vivo: mostra quem está sendo processado agora e quem está aguardando
- Tokens conectados por instância (BOT1, BOT2…)
- Botão para limpar o histórico de respondidos (permite responder novamente)

**Como usar:**
1. Acesse `/messages`
2. Selecione a instância (BOT1, BOT2…)
3. Adicione as mensagens que o bot deve enviar
4. Configure os delays
5. Ative o toggle **"Ativar DM Responder"**

---

### 3. Estatísticas — `/stats`

> Dashboard de performance por organização.

**Acesse por:** `http://SEU_IP:5000/stats`

**O que mostra:**
- **Entradas por org**: quantas vezes o bot entrou na fila de cada organização
- **Partidas por org**: quantas partidas foram detectadas por organização
- **Resumo geral**: total de entradas, partidas detectadas, DMs respondidas
- **Filtro por período**: 24h, 7 dias, 30 dias, tudo
- Botão para resetar todas as estatísticas

---

## Requisitos da VPS

| Software | Versão mínima | Como instalar |
|---|---|---|
| Node.js | **20.x LTS** | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install -y nodejs` |
| npm | 10.x | Já vem com Node 20 |
| PostgreSQL | **14+** | `sudo apt install -y postgresql postgresql-contrib` |

---

## Instalação Completa na VPS

### Passo 1 — Transferir e extrair o projeto

```bash
# Na sua máquina local, envie o arquivo para a VPS:
scp imperiuns-bot.tar.gz usuario@IP_DA_VPS:/home/usuario/

# Na VPS:
cd /home/usuario
tar -xzf imperiuns-bot.tar.gz
cd imperiuns-bot
```

### Passo 2 — Instalar dependências Node

```bash
npm install
```

### Passo 3 — Configurar o PostgreSQL

```bash
# Entrar no console do postgres
sudo -u postgres psql

# Dentro do psql, rodar estes comandos:
CREATE DATABASE empirebot;
CREATE USER empirebot WITH ENCRYPTED PASSWORD 'TROQUE_ESTA_SENHA';
GRANT ALL PRIVILEGES ON DATABASE empirebot TO empirebot;
\q
```

### Passo 4 — Criar o arquivo `.env`

Crie o arquivo `.env` na raiz do projeto (mesmo nível do `package.json`):

```env
# Conexão com o banco de dados
DATABASE_URL=postgresql://empirebot:TROQUE_ESTA_SENHA@localhost:5432/empirebot

# Porta do servidor web (padrão: 5000)
PORT=5000

# Modo produção
NODE_ENV=production

# Senha de login do painel (obrigatório — sem isso o painel não abre)
ADMIN_PASSWORD=CRIE_UMA_SENHA_FORTE

# Segredo da sessão (pode ser qualquer string longa e aleatória)
SESSION_SECRET=mude_isso_para_uma_string_aleatoria_longa_123456
```

> **ATENÇÃO:** `ADMIN_PASSWORD` é a senha que você vai digitar no painel de login.
> Sem ela configurada, o painel retorna erro 500 na autenticação.

### Passo 5 — Criar o schema do banco

```bash
npm run db:init
```

Este comando cria todas as tabelas e aplica migrations automaticamente.
Pode ser rodado múltiplas vezes sem problema (idempotente).

### Passo 6 — Build do frontend

```bash
npm run build
```

Gera os arquivos estáticos do painel em `dist/`.

### Passo 7 — Iniciar o servidor

```bash
npm run start
```

O painel estará disponível em `http://SEU_IP:5000`.

**Login:** usuário `admin` | senha = o valor de `ADMIN_PASSWORD` do `.env`

---

## Rodar como Serviço (reinicia automático com o servidor)

Crie o arquivo `/etc/systemd/system/empirebot.service`:

```ini
[Unit]
Description=EmpireBot — Painel de Controle
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/imperiuns-bot
ExecStart=/usr/bin/npm run start
EnvironmentFile=/home/ubuntu/imperiuns-bot/.env
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

> Ajuste `User=ubuntu` e `WorkingDirectory` para o seu usuário e caminho real.

```bash
# Ativar e iniciar
sudo systemctl daemon-reload
sudo systemctl enable empirebot
sudo systemctl start empirebot

# Ver status
sudo systemctl status empirebot

# Ver logs ao vivo
sudo journalctl -u empirebot -f
```

---

## Nginx — Proxy Reverso (opcional, mas recomendado)

Permite acessar sem a porta `:5000` e habilitar HTTPS.

```bash
sudo apt install -y nginx
```

Crie `/etc/nginx/sites-available/empirebot`:

```nginx
server {
    listen 80;
    server_name SEU_DOMINIO_OU_IP;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/empirebot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

Para HTTPS grátis com Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d SEU_DOMINIO
```

---

## Variáveis de Ambiente — Referência Completa

| Variável | Obrigatória | Descrição | Exemplo |
|---|---|---|---|
| `DATABASE_URL` | ✅ Sim | String de conexão PostgreSQL | `postgresql://user:senha@localhost:5432/db` |
| `ADMIN_PASSWORD` | ✅ Sim | Senha do painel web | `MinhaS3nh@Forte` |
| `PORT` | Não | Porta do servidor (padrão: 5000) | `5000` |
| `NODE_ENV` | Não | `production` ativa cache do frontend | `production` |
| `SESSION_SECRET` | Não | Segredo da sessão (padrão inseguro se omitido) | `string_aleatoria_longa` |

---

## Comandos npm

```bash
npm run dev       # Desenvolvimento (sem build, hot-reload)
npm run build     # Build do frontend para produção
npm run start     # Produção (serve o build da pasta dist/)
npm run db:init   # Cria/atualiza schema do banco (idempotente)
```

---

## Banco de Dados — Tabelas

| Tabela | Descrição |
|---|---|
| `instances` | Instâncias do bot (BOT1, BOT2…) |
| `instance_configs` | Configuração completa por instância |
| `tokens` | Tokens Discord por instância (até 5) |
| `token_pool` | Pool global de tokens compartilhados |
| `instance_token_selection` | Seleção de tokens do pool por instância |
| `orgs` | Organizações/guilds monitoradas |
| `instance_orgs` | Relação instância ↔ orgs habilitadas |
| `org_channels` | Canais de fila descobertos por org |
| `active_queues` | Filas atualmente ocupadas |
| `matches` | Partidas detectadas (com idempotência por canal) |
| `stats` | Contadores: entradas, partidas, DMs, bloqueadas, msgs enviadas |
| `logs` | Log de eventos (rotação automática 7 dias) |
| `token_org_blacklist` | Orgs bloqueadas por token (403 no joinQueue) |
| `match_send_errors` | Erros de envio de mensagem nas partidas por org |
| `dm_config` | Configuração do DM Responder por instância |
| `dm_messages` | Sequência de mensagens do DM Responder |
| `dm_responded` | Usuários que já receberam resposta (deduplicação) |

---

## Funcionalidades Detalhadas

### Engine de Filas (Queue Runner)
- Loop automático busca filas disponíveis nas orgs habilitadas
- **Prioridade para player queues** (filas com adversário já esperando)
- Preenche slots restantes com **empty queues** (isca)
- Rotação de tokens por tempo configurável
- Delay entre cliques com variação aleatória (anti-ban)
- **Filtro de valor máximo**: ignora filas acima do valor configurado (ex: R$5,00)
- **Filtro de nomes bloqueados**: ignora filas com nomes proibidos (counter de "Bloqueadas")
- **Blacklist por token**: cada token tem sua própria lista de orgs proibidas (HTTP 403 no joinQueue)
- **Anti-ban 403**: `fetchMessage` 403 = aviso suave + cache 5min; somente `joinQueue` 403 blacklista

### Match Handler (Detecção de Partidas)
- Listener de `CHANNEL_CREATE` / `THREAD_CREATE` no Discord Gateway
- Padrões detectados: `fila-XXXX`, `partida-XXXX`, `sua-partida-XXXX`, `aguardando-XXXX`
- Fallbacks: `THREAD_MEMBERS_UPDATE`, `MESSAGE_CREATE` (quando mencionado), `GUILD_CREATE` (threads existentes)
- Identifica adversário via `permission_overwrites` ou leitura do embed
- Envia mensagem com variáveis:
  - `{adversary_mention}` — menção `<@ID>` ao adversário
  - `{adversary_id}` — ID puro do adversário
  - `{channel_name}` — nome do canal
  - `{org_name}` — nome da organização
  - `{mode}` — modo (1x1, 2x2…)
  - `{format}` — formato/categoria
  - `{value}` — valor da aposta (R$X,XX)
- Mensagem global OU por org: `nome_da_org | mensagem específica`
- HTTP 403 na partida → blacklista org para aquele token
- Outros erros → registra no painel de **Erros de Envio**

### DM Responder
- Varre `/users/@me/message-requests` a cada ~60s por token
- Aceita implicitamente o request ao enviar a primeira mensagem
- Sequência de mensagens customizável com delay entre elas
- Deduplicação: cada usuário recebe resposta apenas uma vez
- Logs no painel por instância

### Discovery Automática
- Ao salvar configuração, varre as guilds das orgs selecionadas
- Detecta canais de fila por categoria e embed com botões
- Extrai modo, formato e valor monetário automaticamente

---

## Segurança

- **Tokens Discord** ficam salvos em texto puro no Postgres — não exponha o banco publicamente
- **Sempre use senha forte** no `ADMIN_PASSWORD`
- **SESSION_SECRET** deve ser uma string aleatória longa — se omitida, usa um valor fixo inseguro
- Use **Nginx + HTTPS** se o painel for acessível pela internet
- O selfbot **viola os Termos de Serviço do Discord** — use por conta e risco

---

## Atualização (nova versão)

```bash
# Parar o serviço
sudo systemctl stop empirebot

# Extrair nova versão (substitui os arquivos)
tar -xzf imperiuns-bot-nova-versao.tar.gz
cd imperiuns-bot

# Instalar dependências novas (se houver)
npm install

# Aplicar migrations do banco (sempre rodar em updates)
npm run db:init

# Build do frontend
npm run build

# Reiniciar
sudo systemctl start empirebot
```

---

## Health Check

```bash
curl http://localhost:5000/health
# Retorna: {"ok":true,"db":"ok","ts":"2026-01-01T00:00:00.000Z"}
```

---

## Solução de Problemas

| Problema | Causa provável | Solução |
|---|---|---|
| Painel não abre / erro 500 no login | `ADMIN_PASSWORD` não configurada | Adicionar ao `.env` e reiniciar |
| `Error: connect ECONNREFUSED` | PostgreSQL não está rodando | `sudo systemctl start postgresql` |
| `role "empirebot" does not exist` | Usuário do banco não criado | Rodar os comandos SQL do Passo 3 |
| Bot entra na fila mas não envia mensagem | Mensagem principal em branco | Preencher o campo "Mensagem Principal" no painel |
| `HTTP 400` no envio de mensagem | Embed não suportado ou campo inválido | Verificar painel de Erros de Envio |
| DM Responder mostra 0 requests | Endpoint retornou erro | Ver logs da instância na aba `/messages` |
| Partida detectada mas sem envio | Token sem sessão no momento | Aguardar reconexão; o fallback via MESSAGE_CREATE ativa |
