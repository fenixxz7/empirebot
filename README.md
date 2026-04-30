# Imperiuns Bot — Painel de Controle

Selfbot para Discord que automatiza entrada em filas de Free Fire competitivas.
Inclui painel web completo para gerenciamento de tokens, orgs e logs.

---

## Requisitos (VPS)

| Software | Versão mínima |
|---|---|
| Node.js | 20.x LTS |
| npm | 10.x |
| PostgreSQL | 14+ |

---

## Instalação na VPS

### 1. Extrair o pacote

```bash
tar -xzf imperiuns-bot.tar.gz
cd imperiuns-bot
```

### 2. Instalar dependências

```bash
npm install
```

### 3. Configurar o banco de dados

Crie o banco e o usuário no PostgreSQL:

```sql
CREATE DATABASE imperiuns;
CREATE USER imperiuns WITH ENCRYPTED PASSWORD 'suasenha';
GRANT ALL PRIVILEGES ON DATABASE imperiuns TO imperiuns;
```

### 4. Configurar variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
DATABASE_URL=postgresql://imperiuns:suasenha@localhost:5432/imperiuns
PORT=5000
NODE_ENV=production
```

### 5. Criar o schema do banco

```bash
npm run db:init
```

Esse comando é idempotente — pode ser executado múltiplas vezes sem problema.

### 6. Build do frontend

```bash
npm run build
```

### 7. Iniciar o servidor

```bash
npm run start
```

O painel ficará disponível em `http://SEU_IP:5000`.

---

## Executar como serviço (systemd)

Crie o arquivo `/etc/systemd/system/imperiuns.service`:

```ini
[Unit]
Description=Imperiuns Bot
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/imperiuns-bot
ExecStart=/usr/bin/node --import=tsx/esm server/index.ts
EnvironmentFile=/home/ubuntu/imperiuns-bot/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> Ou use `npm run start` no ExecStart se preferir via npm.

```bash
sudo systemctl daemon-reload
sudo systemctl enable imperiuns
sudo systemctl start imperiuns
sudo systemctl status imperiuns
```

---

## Nginx (proxy reverso opcional)

```nginx
server {
    listen 80;
    server_name seudominio.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Estrutura do Projeto

```
imperiuns-bot/
├── server/
│   ├── index.ts              # Ponto de entrada — Express + Vite, rotação de logs
│   ├── db/
│   │   ├── schema.sql        # Schema completo do banco
│   │   ├── init.ts           # Migrations idempotentes
│   │   └── pool.ts           # Pool de conexões pg
│   ├── discord/
│   │   ├── rest.ts           # Cliente HTTP Discord (retry 429 + 5xx)
│   │   └── discovery.ts      # Varredura automática de guilds/canais
│   ├── engine/
│   │   ├── runner.ts         # Loop de filas (player-priority + empty-fill)
│   │   └── match_handler.ts  # Detecção de partidas (CHANNEL_CREATE)
│   ├── worker/
│   │   ├── gateway.ts        # WebSocket Discord Gateway
│   │   └── manager.ts        # Gerência de workers por instância
│   └── routes/
│       ├── index.ts          # Monta rotas + /health
│       ├── config.ts         # Config da instância, export/import
│       ├── instances.ts      # CRUD de instâncias
│       ├── orgs.ts           # CRUD de orgs
│       ├── logs.ts           # Leitura de logs
│       └── discovery.ts      # Trigger manual de discovery
├── src/                      # Frontend React + TailwindCSS
│   ├── App.tsx
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── ControlPanel.tsx
│   │   ├── StatsGrid.tsx
│   │   ├── ConfigForm.tsx    # Formulário principal + export/import
│   │   └── LogsConsole.tsx
│   └── lib/api.ts
├── shared/
│   └── types.ts              # Tipos compartilhados server ↔ client
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

---

## Banco de Dados

| Tabela | Descrição |
|---|---|
| `instances` | Instâncias do bot (BOT1, BOT2…) |
| `instance_configs` | Configuração por instância |
| `tokens` | Tokens Discord (texto puro, até 5 por instância) |
| `orgs` | Organizações/guilds monitoradas |
| `instance_orgs` | Relação instância ↔ orgs habilitadas |
| `org_channels` | Canais de fila descobertos por org |
| `active_queues` | Filas atualmente ocupadas (zerada no stop/boot) |
| `matches` | Partidas detectadas (idempotência) |
| `stats` | Contadores: entradas, na fila, partidas, DMs |
| `logs` | Log de eventos (rotação automática 7 dias) |

---

## Funcionalidades

### Painel Web
- **Controle**: ligar/desligar o bot com um clique
- **Stats em tempo real**: Entradas, Na Fila, Partidas, DMs, Uptime
- **Configuração**: categorias, delay, modos, mensagens, tokens, orgs
- **Export/Import**: exporta toda a configuração como JSON para backup ou migração
- **Logs**: console colorido com níveis INFO/WARN/ERROR e filtro por origem

### Queue Runner
- Prioridade para filas com jogadores (player queues)
- Preenche slots restantes com filas vazias ("isca")
- Rotação de tokens configurável (minutos)
- Delay entre cliques configurável (segundos)
- Até 5 tokens por instância

### Match Handler
- Listener independente de `CHANNEL_CREATE` no Discord Gateway
- Detecta padrões: `fila-XXXX`, `partida-N`, `sua-partida-N`
- Identifica adversário via `permission_overwrites` ou leitura de mensagem
- Envia mensagem customizável com variáveis:
  - `{adversary_mention}` — menção ao adversário
  - `{adversary_id}` — ID do adversário
  - `{channel_name}` — nome do canal da partida
  - `{org_name}` — nome da organização
  - `{mode}` — modo de jogo (1x1, 3x3…)
  - `{format}` — formato do canal
  - `{value}` — valor extraído do embed (R$X)
- Mensagem global ou por org (`org_name | mensagem` ou `guild_id | mensagem`)

### Discovery Automática
- Ao salvar configuração, varre as guilds das orgs selecionadas
- Detecta canais de fila por categoria e botões no embed
- Extrai modo, formato e valor (embed_valor) automaticamente

---

## API REST

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check (DB + timestamp) |
| GET | `/api/instances` | Lista instâncias |
| GET/PUT | `/api/config/:id` | Lê/salva configuração |
| GET | `/api/config/:id/export` | Download JSON da configuração |
| POST | `/api/config/:id/import` | Importa configuração de JSON |
| GET | `/api/orgs` | Lista orgs |
| POST | `/api/orgs` | Cria org |
| DELETE | `/api/orgs/:id` | Remove org |
| GET | `/api/logs/:id` | Busca logs da instância |
| POST | `/api/discovery/:id` | Força discovery manual |

---

## Comandos npm

```bash
npm run dev       # Desenvolvimento (Vite + Express na porta 5000)
npm run build     # Build do frontend para produção
npm run start     # Produção (Express serve o build)
npm run db:init   # Cria/atualiza schema do banco (idempotente)
```

---

## Notas de Segurança

- Tokens Discord ficam salvos em texto puro no Postgres — **não exponha o banco publicamente**
- O painel não tem autenticação — **use firewall ou Nginx com autenticação básica** se a VPS for acessível publicamente
- O selfbot viola os Termos de Serviço do Discord — use por conta e risco

---

## Suporte

Projeto desenvolvido para uso pessoal em VPS. Nenhuma autenticação é necessária no painel.
