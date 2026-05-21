# BOT ORG — Plano Técnico

## Visão Geral

Aba adicional no painel EmpireBot para entrar automaticamente em servidores Discord via convite. Mantém uma fila de invite links, processa sequencialmente com delay anti-ban configurável, resolve CAPTCHA via NopeCHA quando necessário e registra o histórico completo de entradas.

---

## Banco de Dados

### Tabela `org_joiner_config`

Configuração por instância.

| Coluna | Tipo | Default | Descrição |
|---|---|---|---|
| `instance_id` | INTEGER PK FK → instances | — | Chave primária composta |
| `token_value` | TEXT | NULL | Token Discord dedicado (em branco = usa o ativo da instância) |
| `nopecha_key` | TEXT | NULL | Chave da API NopeCHA para resolver HCaptcha |
| `delay_min_ms` | BIGINT | 300000 | Delay mínimo entre entradas (5 min) |
| `delay_max_ms` | BIGINT | 720000 | Delay máximo entre entradas (12 min) |
| `enabled` | BOOLEAN | FALSE | Engine ligada/desligada |

### Tabela `org_queue`

Fila de servidores pendentes e histórico.

| Coluna | Tipo | Default | Descrição |
|---|---|---|---|
| `id` | BIGSERIAL PK | — | |
| `instance_id` | INTEGER FK → instances | — | |
| `invite_code` | TEXT NOT NULL | — | Código extraído (`abc123` de `discord.gg/abc123`) |
| `invite_raw` | TEXT | — | Link original como o usuário colou |
| `status` | TEXT | `pending` | `pending` / `processing` / `done` / `failed` |
| `result_guild_id` | TEXT | NULL | Guild ID obtido após entrada bem-sucedida |
| `result_guild_name` | TEXT | NULL | Nome do servidor após entrada |
| `error_reason` | TEXT | NULL | Motivo de falha se `status=failed` |
| `added_at` | TIMESTAMPTZ | NOW() | |
| `processed_at` | TIMESTAMPTZ | NULL | |

**Índices:**
- `(instance_id, status)` — para buscar próximo `pending`
- `(instance_id, added_at DESC)` — para listar histórico

**Crash recovery:** ao iniciar o engine, qualquer linha com `status='processing'` é resetada para `pending`.

---

## Engine (`server/engine/org-joiner.ts`)

Segue o padrão do `DmResponder` — classe com estado interno e loop de background.

```
OrgJoiner
├── start()
│     → marca startedAt, reseta processing→pending (crash recovery)
│     → acorda tick loop
│
├── stop()
│     → cancela timer, limpa estado em memória
│
├── addInvite(inviteRaw)
│     → extrai invite_code do link
│     → GET /invites/{code} para validar + preview (nome do servidor)
│     → INSERT em org_queue com status=pending
│     → acorda loop se estava esperando
│
├── tick()  [loop principal]
│     → SELECT próximo pending ORDER BY added_at ASC
│     → se vazio: dorme 10s e verifica de novo
│     → UPDATE status=processing
│     → chama processInvite()
│     → dorme delay aleatório (delay_min..delay_max)
│     → próxima iteração
│
├── processInvite(item)
│     → POST /invites/{code} com token configurado
│     ├── 200 OK → status=done, guild_id, guild_name, incrementa counter
│     ├── 401/403 → status=failed, reason=token_inválido/sem_permissão
│     ├── 429 → dorme retry_after, tenta de novo (até 3x)
│     ├── CAPTCHA (hcaptcha_key presente) → chama NopeCHA → resolve → retry
│     └── outros erros → status=failed, reason=HTTP_{code}
│
└── getSnapshot()
      → { running, startedAt, counter, currentItem, queueSize }
```

### Integrações Discord REST (adicionar em `server/discord/rest.ts`)

```typescript
// Preview do servidor antes de entrar (valida link)
getInvite(code: string): Promise<{ guild?: { id: string; name: string } }>

// Entrar no servidor
acceptInvite(code: string): Promise<{ guild_id: string; ... }>
```

Ambas requerem o token no header `Authorization`.

### Integração NopeCHA

Chamada HTTP para `https://nopecha.com/api/hcaptcha`:
```
POST https://nopecha.com/api/token
  { key, type: "hcaptcha", sitekey, url }
→ { data: "token_resolvido" }
```

---

## Rotas (`server/routes/org-joiner.ts`)

Montadas em `/api/org-joiner` via `server/routes/index.ts`.

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/config/:id` | Ler configuração da instância |
| `PUT` | `/config/:id` | Salvar config (token, nopecha_key, delays, enabled) |
| `GET` | `/queue/:id` | Listar fila completa (pending + histórico recente) |
| `POST` | `/queue/:id` | Adicionar um ou mais invite links à fila |
| `DELETE` | `/queue/:id/:qid` | Remover item pendente da fila |
| `POST` | `/start/:id` | Ligar engine |
| `POST` | `/stop/:id` | Desligar engine |
| `GET` | `/snapshot/:id` | Estado em tempo real (consumido pelo frontend a cada 3s) |

**Resposta de `/snapshot`:**
```json
{
  "running": true,
  "startedAt": "2026-05-20T21:00:00Z",
  "uptimeMs": 3600000,
  "counter": 7,
  "currentItem": { "id": 12, "invite_code": "abc123", "invite_raw": "discord.gg/abc123" },
  "queueSize": 3
}
```

---

## Frontend (`src/pages/OrgJoiner.tsx`)

Polling de 3 s em `/api/org-joiner/snapshot/:id`.

### Layout

```
┌──────────────────── BOT FILA │ BOT DM │ [BOT ORG] ────────────────────┐
│                    🟢 Conectado  🔴 Parado                              │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────┐  ┌─────────────┐  ┌─────────────────┐
│  ⏻ Controle - Bot Org          │  │ ✓ Entradas  │  │ ⏱ Uptime       │
│                                │  │             │  │                 │
│          [ ▶ / ■ ]             │  │      0      │  │   00:00:00      │
│                                │  │  servidores │  │   sem falhas    │
│  "Adicione servidores          │  │  entrados   │  │                 │
│   pendentes" (fila vazia)      │  └─────────────┘  └─────────────────┘
└────────────────────────────────┘

┌─────────────────────────────────┐  ┌──────────────────────────────────┐
│  ⚙ Configuração                  │  │  + Adicionar Servidor            │
│                                 │  │                                  │
│  Token Discord  ✓ configurado   │  │  [discord.gg/codigo ou URL ____] │
│  [_____________________________]│  │                          [+ Add] │
│                                 │  └──────────────────────────────────┘
│  Chave NopeCHA                  │
│  [_____________________________]│  ┌──────────────────────────────────┐
│                                 │  │  📋 Fila / Histórico             │
│  Delay entre entradas (anti-ban)│  │                                  │
│  Mínimo (min)   Máximo (min)    │  │  • pending   discord.gg/xxx      │
│  [  5  ]   —   [  12  ]        │  │  ✓ done      Nome do Servidor    │
│  Padrão: 5–12 min. Maior = menos│  │  ✗ failed    discord.gg/yyy  (!) │
│                                 │  └──────────────────────────────────┘
│  [💾 Salvar Config]             │
└─────────────────────────────────┘
```

### Estados do botão de controle

| Condição | Botão | Texto auxiliar |
|---|---|---|
| Fila vazia | ▶ cinza (disabled) | "Adicione servidores pendentes" |
| Fila com itens, parado | ▶ branco (clicável) | "X servidores na fila" |
| Rodando | ■ vermelho (stop) | "Processando: discord.gg/abc..." |

### Badge de status

Reutiliza o componente de status existente do Header:
- 🟢 **Conectado** — token válido e reconhecido
- 🔴 **Parado** — engine inativa

### Painel de fila/histórico

Lista ordenada por `added_at DESC`, ícone colorido por status:
- ⏳ `pending` — amarelo
- ⚙️ `processing` — azul pulsante
- ✅ `done` — verde + nome do servidor
- ❌ `failed` — vermelho + motivo da falha (tooltip ou texto inline)

---

## Navegação (`src/components/Header.tsx`)

Adicionar tab `"BOT ORG"` ao lado de `"BOT DM"` dentro do loop de abas por instância — mesmo padrão de tab que já existe para BOT FILA e BOT DM.

---

## Integração com Manager (`server/worker/manager.ts`)

- Na inicialização do worker por instância: criar e armazenar instância de `OrgJoiner` (desligada por padrão)
- Expor `getOrgJoiner(instanceId): OrgJoiner` para as rotas acessarem via `app.locals` ou via o próprio manager
- **Sem eventos de Gateway necessários** — OrgJoiner é 100% REST-driven (ele inicia as chamadas, não reage a eventos do Discord)

---

## Estrutura de Arquivos

### Novos arquivos

```
server/
  engine/
    org-joiner.ts              ← engine: fila, loop, processamento, NopeCHA
  routes/
    org-joiner.ts              ← API REST da feature

src/
  pages/
    OrgJoiner.tsx              ← página React com polling
```

### Arquivos modificados

```
server/db/init.ts              ← +tabelas org_joiner_config e org_queue
server/discord/rest.ts         ← +getInvite(), +acceptInvite()
server/routes/index.ts         ← montar /api/org-joiner
server/worker/manager.ts       ← instanciar OrgJoiner por instância
src/components/Header.tsx      ← tab BOT ORG
```

---

## Pontos de Atenção

| Tópico | Detalhe |
|---|---|
| **Token isolado** | BOT ORG usa token próprio — risco de ban segregado dos bots de fila |
| **Crash recovery** | `status='processing'` → `'pending'` no start do engine |
| **Validação de invite** | `GET /invites/{code}` antes de enfileirar — mostra preview do servidor ao usuário e rejeita links inválidos |
| **Rate limit 429** | Respeitar `retry_after` do Discord; logar e tentar de novo até 3x |
| **NopeCHA opcional** | Se `nopecha_key` estiver em branco, falha com `reason=captcha_sem_chave` em vez de travar |
| **Delay realista** | Delay calculado no fim de cada entrada (não no início) — inclui jitter `±10%` sobre o valor sorteado |
| **Múltiplas instâncias** | Cada BOT1/BOT2/BOT3 tem sua própria fila e config isoladas |
