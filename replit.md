# Imperiuns Bot — Painel

Selfbot panel em português para automatizar entrada em filas de Free Fire em
servidores Discord. Reconstrução do projeto original do usuário.

## Stack

- Node 20 + TypeScript (ESM), Express + Vite middleware (mesmo processo, porta 5000)
- React 18 + TailwindCSS, tema dark navy
- PostgreSQL via `pg`
- WebSocket (`ws`) para conexão direta com o Discord Gateway e para streaming em tempo real de stats/logs para o painel (`/ws/:instanceId`)

## Instâncias

O sistema seed dois bots: BOT1 e BOT2. O painel mostra abas de instância no topo para alternar entre elas.

## Comandos

- `npm run dev` — sobe o servidor em modo dev (Vite + Express na 5000).
  Importante: não usar `tsx watch` aqui — o watch trava silenciosamente neste
  ambiente. O dev script já roda `tsx server/index.ts`.
- `npm run build` / `npm run start` — produção.
- `npm run db:init` — recria/atualiza schema e seed.

## Estrutura

```
server/
  index.ts            Express + Vite middleware, religa workers no boot
  db/                 schema, pool, init/seed
  routes/             instances, config, orgs, logs
  worker/
    gateway.ts        Cliente Gateway Discord (Hello/Identify/Heartbeat/Resume)
    manager.ts        Gerencia workers por instância e atualiza tokens/logs
shared/types.ts       Tipos compartilhados front+back
src/                  React app (App, components, lib/api)
```

## Filtro por categoria de canal (multi-fila por canal)

- **Categorias suportadas**: `Mobile`, `Misto`, `Emulador`, `Tatico`, `Full-Soco`.
- **Detecção** (`server/discord/discovery.ts → detectCategory`): por sufixo do
  nome do canal. Ordem importa porque `full-soco` precisa bater antes de
  `soco`, `misto` antes de `mis`, etc.
  - `1x1-mob` → Mobile
  - `2x2-misto` ou `2x2-mis` → Misto
  - `3x3-emu` → Emulador
  - `4x4-tatico` → Tatico
  - `1x1-full-soco` → Full-Soco
- **Multi-mensagem por canal**: cada canal pode ter vários cards (cada R$X
  é uma mensagem com componentes), então `org_channels` agora tem
  `UNIQUE(org_id, channel_id, message_id)` e `discoverOrg` itera todas as
  mensagens com componentes (não só a 1ª). Mensagens deletadas no canal são
  removidas do banco no próximo discovery. Cada row guarda `embed_title`
  pra distinguir as filas no log/UI.
- **`active_queues`** também passou a `UNIQUE(instance_id, channel_id, message_id)`
  pra permitir múltiplas filas ativas por canal sem colisão.
- **`instance_configs.allowed_categories`** (TEXT, multi-valor separado por
  espaço/vírgula/quebra de linha) substitui o filtro single `category`.
  A coluna `category` antiga continua existindo (preenchida com a primeira
  categoria selecionada) só pra compatibilidade.
- **Runner** (`server/engine/runner.ts → loadChannels`): filtra com
  `WHERE oc.category = ANY($3::text[])` usando a lista de allowed_categories.
  Canais sem categoria detectada **não entram no rodízio**.
- **UI** (`src/components/ConfigForm.tsx`): a Section "Categorias permitidas"
  é um grid de 5 botões-checkbox (não dropdown). A lista de orgs deixou de
  filtrar por categoria — mostra todas as orgs cadastradas, e o filtro
  acontece por canal. O form "Adicionar org" ganhou dropdown de categoria
  com as 5 opções (mas o valor é apenas metadata informativa da org).
  O badge ao lado da org mostra "N filas" (não "N canais") já que cada card
  é uma fila distinta.

## Estado atual (Bloco D — Fases 9 e 10 adicionadas)

- Painel renderiza, controla start/stop da instância e salva configuração.
- Worker abre conexão WSS com `gateway.discord.gg` para cada token salvo,
  faz handshake completo, mantém heartbeat com jitter, retoma sessão (RESUME)
  após queda e reconnecta com backoff. Códigos 4004/4010-4014 marcam token como
  inválido.
- Status por token aparece na tela de Configuração; cabeçalho mostra
  "Conectado · <handle>" do primeiro token ativo e contador de tokens ativos.
- Quando o servidor reinicia, instâncias com `running=true` têm os workers
  religados automaticamente.
- Salvar configuração com a instância em execução **para o bot
  automaticamente** e exige re-início manual (rede de segurança no
  backend + botão "SALVAR" desabilitado na UI com aviso âmbar enquanto
  `running=true`).
- Tabela `org_channels` guarda canais de fila descobertos por org com modo
  detectado (1x1/2x2/3x3/4x4) e cada botão classificado (entrar/sair/jogar
  × normal/gel_normal/gel_inf/full_ump_xm8).
- Gerenciamento de orgs no painel: dois modos exclusivos — "Adicionar org"
  (form inline com nome + guild_id opcional) e "Apagar org" (checkboxes
  vermelhos com Confirmar/Cancelar). Sem mais edição via lápis.
- Descoberta automática integrada ao salvar: ao clicar "SALVAR CONFIGURAÇÃO",
  para cada org selecionada que tenha guild_id mas zero canais cadastrados,
  o backend dispara `discoverOrg` usando o token #1 conectado e cadastra os
  canais + botões. Resposta do PUT inclui `discovery[]` e `discovery_skipped`
  pra feedback no toast.
- Endpoints novos: `POST /api/orgs` (criar), `DELETE /api/orgs/:id` (apagar).
  `PATCH /api/orgs/:id` continua existindo mas não é mais usado pela UI.
- `POST /api/discovery/:instanceId` continua disponível como fallback manual,
  mas não há mais botão na UI.
- **Motor de filas** (`server/engine/runner.ts`): loop por instância iniciado
  pelo `manager.start`. A cada `delay_seconds` ± 30% de jitter:
  - lê config (`allowed_modes`, `selected_org_ids`)
  - busca tokens conectados via `manager.getActiveTokens()` (que expõe
    `session_id` e `user_id` do gateway)
  - lista canais elegíveis (org selecionada × modo permitido × tem botão
    válido × tem `application_id`/`message_id`/`guild_id`)
  - filtra os já em `active_queues` e os de orgs no limite (`max_queues`)
  - **sequencial por org**: usa `orgCursor` por instância — esgota todas as
    filas de uma org antes de passar pra próxima. Quando uma org satura
    (atingiu `max_queues` ou não há mais canais elegíveis), avança o cursor.
  - **prioriza filas com player**: pra cada candidato da org atual faz um
    `GET /channels/:cid/messages/:mid` (`fetchMessage` no rest.ts) e conta
    menções `<@id>` no embed (description + fields). Filas com mais
    jogadores entram primeiro; vazias entram só quando saturar (vira
    "isca" pra esperar alguém clicar). Cache de 25s por mensagem,
    máximo 6 fetches por tick, jitter de 120-320ms entre fetches.
  - antes de clicar, sleep extra de 350-1500ms (anti-burst humanizado)
  - clica o botão usando `DiscordRest.clickButton` (POST `/interactions`
    com `type: 3`, `session_id`, `application_id`, etc.)
  - sucesso: insere em `active_queues`, incrementa `entradas`, atualiza
    `na_fila`, atualiza `last_used_at` do token, log INFO com nome do
    botão clicado entre aspas e contagem de player se houver
  - 429: log WARN e espera próximo tick
- **Picker de botão** (`server/engine/runner.ts → pickEnterButton`): aceita
  uma cadeia de tiers (não só `enter`). Ordem de preferência:
  1. `enter` + variant normal (Entrar / Entrar Normal)
  2. `play` + variant normal (Jogar Normal — caso da Morro)
  3. `other` + variant null/normal/gel_normal (Gel Normal, 1 Emu, etc.)
  4. fallback `play` + full_ump_xm8 (Jogar Full UMP & XM8)
  5. fallback `other` + gel_inf (Gel Inf, 2/3 Emu)
  Sempre exclui botões com `disabled=true` ou action `leave`.
- **Logs coloridos**: `src/index.css` define classes `.lvl-INFO/WARN/ERROR`
  e `.src-gateway/engine/discovery/config/control/worker/match`.
  `LogsConsole.tsx` aplica cor por nível e tag pintada por origem.
- `active_queues` é zerada na parada da instância e no boot do servidor.

## Fases 9 e 10 — implementadas

- **MatchHandler** (`server/engine/match_handler.ts`): listener independente do
  runner de filas. Ativado por `CHANNEL_CREATE` no gateway para qualquer token
  da instância.
  - Detecta padrões: `fila-XXXX`, `partida-N`, `sua-partida-N`.
  - Adversário: 1) `permission_overwrites` tipo user (id ≠ nosso token),
    2) fallback: aguarda 2s, lê primeira mensagem do canal e extrai menção.
  - Idempotência via tabela `matches (instance_id, channel_id) UNIQUE`.
  - Libera slot em `active_queues` para a org da guild (match = fila consumida).
  - Incrementa `stats.partidas` e `stats.dms`.
  - Resolve template: mensagem global ou por-org (`message_per_org` no formato
    `org_name | mensagem` ou `guild_id | mensagem`).
  - Substitui variáveis: `{adversary_mention}`, `{adversary_id}`,
    `{channel_name}`, `{org_name}`, `{mode}`, `{format}`, `{value}`.
  - Envia via `POST /channels/:id/messages` com o token ativo.
- Loop de filas (runner) e loop de partidas (match_handler) são completamente
  independentes — o runner não precisa ter entrado com player para a mensagem
  ser enviada.

## Bloco E — implementado

- **Retry 5xx** (`server/discord/rest.ts`): após 429 já havia retry; agora
  respostas `>= 500` também fazem até 3 tentativas com backoff exponencial
  (1s → 2s → 4s, máx 8s).
- **`/health`** (`server/routes/index.ts`): endpoint GET que faz `SELECT 1` no
  Postgres e retorna `{ ok, db, ts }` (503 se DB offline).
- **Rotação de logs** (`server/index.ts`): job a cada 6h deleta registros com
  mais de 7 dias na tabela `logs`. Roda também no boot.
- **Export config** (`GET /api/config/:id/export`): retorna JSON com `version`,
  `exported_at`, campos de `instance_configs` e lista de orgs selecionadas.
  Content-Disposition faz download direto.
- **Import config** (`POST /api/config/:id/import`): aceita o mesmo JSON,
  atualiza `instance_configs` e `instance_orgs`, registra evento nos logs.
- **Botões no painel** (`src/components/ConfigForm.tsx`): "Exportar config" e
  "Importar config" abaixo do botão salvar. Import usa `<input type="file">`
  hidden acionado por ref.

## Bloco F — implementado

- **Rotação automática de tokens** (`server/worker/manager.ts`): timer global
  (tick de 5s) decrementa um contador por instância carregado de
  `instance_configs.rotation_minutes`. Quando chega a zero, avança o índice
  do token ativo (round-robin) e reseta o contador.
  - `getActiveTokens(instanceId)` rotaciona o array antes de devolver, então
    o token "rotacionado" é o `tokens[0]` que o runner usa por padrão.
  - O runner (`server/engine/runner.ts`) ficou simples: usa `tokens[0]`,
    sem manter contador próprio.
  - `manager.getNextRotationSeconds(id)` é exposto via
    `GET /api/instances` e via `WS broadcast` em cada evento de stats
    (`payload.next_rotation_seconds`).
  - Salvar config com `rotation_minutes` novo chama
    `manager.updateRotationMinutes` na hora (sem precisar reiniciar bot).
  - UI (`src/components/StatsGrid.tsx`): card "Próxima rotação" aparece ao
    lado do Uptime quando a instância está rodando e tem >1 token ativo.
- **Imagem na mensagem de partida** (`server/discord/rest.ts`,
  `server/engine/match_handler.ts`): novo campo `instance_configs.image_url`.
  Se preenchido, `sendMessage` anexa um embed com `{ image: { url } }` na
  mensagem enviada no canal de partida. Log da partida inclui tag
  "· com imagem" quando há URL.
  - UI (`src/components/ConfigForm.tsx`): nova Section "Imagem na mensagem
    (URL)" com input + preview da imagem.

## Próximos blocos planejados

- Estatísticas por org (orgs com mais partidas/entradas).

## Preferências do usuário

- Comunicação em português.
- Sem login no painel (uso pessoal em VPS).
- Tokens são guardados em texto puro no Postgres (decisão explícita do
  usuário neste momento).
- BOT1 e BOT2 ambos ativos (abas no topo do painel).
- Orgs: o usuário vai mandar os IDs reais; quando vier, atualizar o seed em
  `server/db/init.ts` e cadastrar via `guild_id`.
