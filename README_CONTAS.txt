================================================================================
  IMPERIUNS BOT — MÓDULO DE CONTAS (Camada de Estabilidade e Observabilidade)
================================================================================
Versão: 2.0 — Stability & Observability Layer
Data: 2026-05

--------------------------------------------------------------------------------
ÍNDICE
--------------------------------------------------------------------------------
 1. Visão Geral
 2. Arquitetura de Dados
 3. Ciclo de Vida de uma Conta
 4. Engine de Auto-Rotação (auto-rotator.ts)
    4.1 Estratégias de Rotação
    4.2 9 Passos Transacionais
    4.3 Anti-Pingpong (rotation_memory)
    4.4 Smart Cooldown
    4.5 Session Stability Score
 5. Failover
 6. Rollback Automático
 7. Watchdog Global (watchdog.ts)
    7.1 Checks do Watchdog
    7.2 Alertas e Severidade
 8. Modos de Operação do Sistema
    8.1 Emergency Mode
    8.2 Readonly Recovery Mode
    8.3 Rotation Paused
    8.4 Watchdog Pause (automático)
 9. Painel de Saúde do Sistema (tab 🏥 Sistema)
    9.1 Status Geral
    9.2 Controles de Modo
    9.3 Métricas de Pool
    9.4 Métricas de Rotação
    9.5 Saúde por Instância
    9.6 Alertas do Watchdog
10. API REST (endpoints)
11. Tabelas do Banco de Dados
12. Fluxo Operacional Resumido
13. Guia de Troubleshooting
14. Exemplos de Cenários

================================================================================
1. VISÃO GERAL
================================================================================
O módulo de contas gerencia um pool de contas Discord (selfbots) para múltiplas
instâncias de bot. Cada instância usa exatamente uma conta ativa por vez. O
sistema rotaciona contas automaticamente com base em saúde, tempo de uso,
falhas e limitações de rate limit.

A Camada de Estabilidade e Observabilidade (v2.0) adiciona:
  - Anti-pingpong persistente (evita reuso imediato de conta)
  - Smart Cooldown (multiplica cooldown por fator dinâmico por motivo)
  - Session Stability Score (score 0-100 de qualidade da sessão)
  - Watchdog Global (detecta anomalias e pausa rotação automaticamente)
  - Emergency Mode / Readonly Recovery Mode / Rotation Paused
  - Painel de Saúde do Sistema na UI (tab 🏥 Sistema)
  - Métricas operacionais (rotações/h, failovers/h, rollbacks/h)

================================================================================
2. ARQUITETURA DE DADOS
================================================================================

Tabelas principais:
  accounts              — Pool de contas com estado, saúde, locks, cooldowns
  instances             — Instâncias de bot (BOT1, BOT2, etc.)
  accounts_config       — Configuração global única (id=1)
  account_logs          — Log de eventos por conta

Tabelas de observabilidade (v2.0):
  rotation_history      — Histórico completo de todas as rotações
  rotation_memory       — Anti-pingpong persistente (last_used_at por inst+conta)
  watchdog_alerts       — Alertas do watchdog com severidade e status de resolução

Campos novos em accounts_config (v2.0):
  emergency_mode          BOOLEAN  — Bloqueia rotações normais (só failover)
  readonly_recovery_mode  BOOLEAN  — Bloqueia TUDO (modo de recuperação)
  rotation_paused         BOOLEAN  — Pausa manual de rotações
  smart_cooldown          BOOLEAN  — Habilita multiplicadores dinâmicos de cooldown
  stability_weight        INTEGER  — Peso do stability score na seleção (0–100)

Estados possíveis de uma conta (accounts.state):
  IDLE                — Disponível, nunca usada ou em standby
  ACTIVE              — Sendo usada por uma instância (com lock)
  COOLING             — Em cooldown após rotação
  STANDBY             — Aguardando uso
  WAITING             — Aguardando confirmação de ação
  LOCKED              — Bloqueada manualmente
  SUSPENDED           — Suspensa temporariamente
  BANNED              — Banida (permanente ou longa duração)
  DEAD                — Inacessível/inativa definitivamente
  ERROR               — Erro persistente desconhecido
  INVALID_TOKEN       — Token inválido ou expirado
  NEEDS_VERIFICATION  — Requer verificação manual
  LOGIN_CHALLENGE     — Desafio de login (captcha, 2FA, etc.)
  MANUAL_ACTION_REQUIRED — Requer ação manual urgente

================================================================================
3. CICLO DE VIDA DE UMA CONTA
================================================================================

  IDLE ──────────────────────────────────► ACTIVE (rotação seleciona a conta)
   │                                          │
   │                                          ├──[rotação normal]──► COOLING
   │                                          │                          │
   │                                          ├──[falha/ban]──────► BANNED/ERROR
   │                                          │
   │                                          └──[token inválido]──► INVALID_TOKEN
   │
  COOLING ──[cooldown_until expirado]────► IDLE
  BANNED  ──[revisão manual]─────────────► IDLE (se recuperável)
  ERROR   ──[auto-retry ou manual]────────► IDLE

Locks:
  - Conta ACTIVE tem: account_lock=TRUE, locked_by_instance=<id>,
    lock_expires_at=<ts>
  - Locks expirados são liberados automaticamente no início de cada GET /api/accounts
  - O health monitor também libera locks expirados periodicamente
  - O Watchdog verifica locks órfãos (ativos há >30min sem rotação recente)

================================================================================
4. ENGINE DE AUTO-ROTAÇÃO (auto-rotator.ts)
================================================================================

Motivos de rotação (RotationReason):
  manual                — Acionado manualmente pelo painel
  scheduled             — Rotação periódica programada (max_continuous_ms)
  rate_limit            — Rate limit detectado no Discord
  session_dead          — Sessão morta/desconectada
  token_invalid         — Token inválido
  shadow_limit          — Limite de sombra (shadowban)
  health_degraded       — Saúde abaixo do mínimo configurado
  consecutive_failures  — Muitas falhas consecutivas
  heartbeat_failed      — Heartbeat Discord falhou
  quarantine            — Conta em quarentena expirada
  critical_state        — Estado crítico detectado
  failover              — Failover de emergência

4.1 ESTRATÉGIAS DE ROTAÇÃO
---------------------------
  round_robin       — Rotação circular simples
  weighted_health   — Peso pelo health_score (padrão recomendado)
  least_used        — Conta menos utilizada (menor rotation_count)
  random            — Aleatório
  priority          — Por campo priority DESC

4.2 9 PASSOS TRANSACIONAIS
---------------------------
Cada rotação executa os seguintes passos em sequência, com rollback completo
em caso de falha em qualquer etapa:

  1. Seleção de candidato — Query com filtros de estado, cooldown, quarentena,
     anti-pingpong, e pontuação por estratégia + stability_weight.
  2. Verificação de anti-pingpong — Conta não pode ser reusada dentro de
     min(cooldown_ms, 5 minutos) pelo anti-pingpong em memória e BD.
  3. Tentativa de lock — UPDATE com lock otimista (account_lock = FALSE → TRUE).
     Se lock falhar (conta pega por outra rotação concorrente), tenta próximo.
  4. Rollback guard — Registra lock_expires_at e prepara ponto de rollback.
  5. Ativação da nova conta — state = 'ACTIVE', locked_by_instance, lock_expires_at.
  6. Liberação da conta antiga com smart cooldown — state = 'COOLING', cooldown_until.
  7. Registro de anti-pingpong — Atualiza rotation_memory (instância + conta + ts).
  8. Atualização de estado e histórico — rotation_history INSERT, lastRotationReason.
  9. Notificação — Log de conclusão com conta nova e tempo de rotação.

4.3 ANTI-PINGPONG (rotation_memory)
-------------------------------------
Problema evitado: Sistema rotaciona conta A → B → A → B em loop.

Solução:
  - Em memória: Map de (instanceId, accountId) → timestamp de último uso.
  - Persistente: Tabela rotation_memory com last_used_at (sobrevive a restarts).
  - Ao selecionar candidato: filtra contas usadas recentemente (dentro do
    cooldown ou 5 minutos, o que for maior).
  - Ao iniciar (startHealthMonitor): carrega rotation_memory do BD em memória.
  - A cada ciclo (30s): re-sincroniza flags do BD (syncSystemFlagsFromDb).

4.4 SMART COOLDOWN
-------------------
Quando smart_cooldown = TRUE (padrão), o cooldown após rotação não é fixo.
É calculado com multiplicadores dinâmicos por motivo:

  Motivo                  Multiplicador
  ───────────────────────────────────────
  rate_limit              3.0×
  token_invalid           2.5×
  shadow_limit            2.5×
  session_dead            2.0×
  heartbeat_failed        2.0×
  consecutive_failures    1.5×  (+ 0.3× por falha extra acima de 3, cap 5.0×)
  health_degraded         1.3×
  quarantine              1.2×
  critical_state          1.5×
  manual / outros         1.0×

  Se consecutive_failures > 3: multiplica por (1.5 + 0.3 × (falhas - 3)), cap 5.0×.
  Se smart_cooldown = FALSE: usa cooldown_after_use_ms fixo sem multiplicadores.

4.5 SESSION STABILITY SCORE
-----------------------------
Calculado sob demanda (calcStabilityScore) com base em:
  - Proporção de rotações bem-sucedidas nas últimas 24h
  - Penalidade por falhas consecutivas
  - Penalidade por eventos de erro recentes

Score 0–100. Usado como critério de desempate na seleção de candidatos quando
stability_weight > 0 na configuração.

================================================================================
5. FAILOVER
================================================================================
Quando uma sessão Discord morre inesperadamente (não por rotação programada),
o worker chama triggerFailover(instanceId, oldAccountId).

Diferenças do failover vs. rotação normal:
  - NÃO é bloqueado por Emergency Mode (pode rodar mesmo em emergência)
  - NÃO é bloqueado por Rotation Paused ou Watchdog Pause
  - Readonly Recovery Mode bloqueia ATÉ o failover
  - Registrado no rotation_history com result='failover'
  - O failover conta para detecção de failovers excessivos no Watchdog

================================================================================
6. ROLLBACK AUTOMÁTICO
================================================================================
Se qualquer passo da rotação falhar após o lock ser obtido:
  - A conta nova tem seu lock liberado imediatamente
  - A conta antiga tem seu estado restaurado (state = 'ACTIVE', lock recolocado
    com lock_expires_at estendido)
  - O evento é registrado como result='rollback' no rotation_history
  - Um log de erro é gerado no account_logs
  - Alta taxa de rollbacks (>3/h) gera alerta do Watchdog

================================================================================
7. WATCHDOG GLOBAL (watchdog.ts)
================================================================================
O Watchdog roda a cada 60 segundos (startWatchdog) e verifica 7 condições.
Quando detecta problema, insere alerta em watchdog_alerts e pode pausar
automaticamente a rotação via setWatchdogPause().

7.1 CHECKS DO WATCHDOG
------------------------
  orphan_lock (severity: high)
    Lock ativo há mais de 30min sem rotação recente → libera lock automaticamente
    e gera alerta.

  rotation_loop (severity: critical)
    Mais de 5 rotações em 1 hora para uma mesma instância → pausa watchdog
    e gera alerta crítico.

  excessive_failovers (severity: critical)
    Mais de 3 failovers em 30min → pausa watchdog e gera alerta crítico.

  account_oscillation (severity: high)
    Mesma conta ativada/desativada 3+ vezes em 1h → alerta de alta severidade
    (possível loop de conta específica sem anti-pingpong efetivo).

  pool_empty (severity: critical)
    Pool sem nenhuma conta usável → alerta crítico.

  pool_critical (severity: high)
    Pool com menos de 20% de contas usáveis → alerta de alta severidade.

  high_rollback_rate (severity: high)
    Mais de 3 rollbacks em 1h → alerta de alta severidade (possível problema
    de concorrência, DB ou lock starvation).

7.2 ALERTAS E SEVERIDADE
--------------------------
Severidades:
  critical  — Situação que impede operação. Exige ação imediata.
  high      — Situação degradada. Investigar em breve.
  medium    — Anomalia. Monitorar.
  low       — Informativo.

Para resolver um alerta: clicar "Resolver" no painel 🏥 Sistema, ou via API:
  POST /api/accounts/watchdog-alerts/:id/resolve

O Watchdog Pause é liberado automaticamente quando a condição que o causou
não for mais detectada no próximo ciclo (60s). Também pode-se usar o toggle
"Rotação Pausada" no painel para controle manual.

================================================================================
8. MODOS DE OPERAÇÃO DO SISTEMA
================================================================================

8.1 EMERGENCY MODE (🚨 Modo Emergência)
  Ativado quando: situação crítica que exige intervenção mas não pode parar tudo.
  Efeito:
    - Rotações normais e programadas BLOQUEADAS
    - Failovers AINDA PERMITIDOS (para recuperar sessões mortas)
    - Watchdog continua rodando
  Como desativar: Painel 🏥 Sistema → toggle "Modo Emergência" → OFF

8.2 READONLY RECOVERY MODE (🔒 Somente Leitura)
  Ativado quando: manutenção completa sem nenhuma rotação.
  Efeito:
    - TODAS as rotações bloqueadas (inclusive failover)
    - Sistema em modo de leitura para análise segura
  Cuidado: Sessions mortas NÃO serão recuperadas automaticamente!
  Como desativar: Painel 🏥 Sistema → toggle "Somente Leitura" → OFF
  Emergência: UPDATE accounts_config SET readonly_recovery_mode=FALSE WHERE id=1;

8.3 ROTATION PAUSED (⏸ Rotação Pausada)
  Pausa manual temporária das rotações automáticas. Failovers continuam.
  Útil para manutenção curta (ex: atualização de tokens).
  Como retomar: Painel 🏥 Sistema → toggle "Rotação Pausada" → OFF

8.4 WATCHDOG PAUSE (automático)
  Ativado automaticamente quando o Watchdog detecta rotation_loop ou
  excessive_failovers. Bloqueia rotações mas permite failovers.
  Liberado automaticamente no próximo ciclo do watchdog (60s) se a condição
  não persistir. Visível no painel como badge "Watchdog Pause".

Prioridade de bloqueio (maior → menor):
  readonly_recovery_mode > emergency_mode > (rotation_paused | watchdog_paused)

================================================================================
9. PAINEL DE SAÚDE DO SISTEMA (tab 🏥 Sistema)
================================================================================
Acesso: Painel → aba Contas → tab "🏥 Sistema"

9.1 STATUS GERAL
  Badge no topo indica o status consolidado:
    SAUDÁVEL       (verde)        — Sistema operando normalmente
    DEGRADADO      (âmbar)        — Failovers ou pool parcialmente comprometido
    CRÍTICO        (vermelho)     — Falhas graves, pool vazio ou muitos failovers
    EMERGÊNCIA     (vermelho esc) — Emergency Mode ativo
    SOMENTE LEITURA (roxo)        — Readonly Recovery Mode ativo

  Critérios de cálculo (em prioridade):
    EMERGÊNCIA     → emergency_mode = true
    SOMENTE LEITURA → readonly_recovery_mode = true
    CRÍTICO        → failovers ≥ 3/h OU health_approx < 30 OU pool usável = 0
    DEGRADADO      → failovers ≥ 1/h OU health_approx < 60
                     OU (usável/total < 30%) OU rollbacks ≥ 2/h
    SAUDÁVEL       → nenhuma condição acima

9.2 CONTROLES DE MODO
  Botões de toggle para cada flag. Efeito imediato (atualiza DB + memória).
  Vermelho = ativo (estado de atenção), ciano = ativo (normal).

9.3 MÉTRICAS DE POOL
  Cards: Total / Ativas / Usáveis / Cooldown / Quarentena
  Percentuais calculados em relação ao total do pool.
  Barra de composição visual (verde=ativas, âmbar=cooldown, vermelho=quarentena).

9.4 MÉTRICAS DE ROTAÇÃO
  Cards: Rotações/1h | Failovers/1h | Rollbacks/1h | Rotações/24h | Abortadas/24h
  Cores indicam severidade conforme limites do Watchdog.

9.5 SAÚDE POR INSTÂNCIA
  Card por instância com badge de status e métricas individuais de rotação/failover.

9.6 ALERTAS DO WATCHDOG
  Lista de alertas com alertas abertos destacados.
  Botão "Resolver" disponível para cada alerta aberto.
  Alertas resolvidos ficam visíveis mas esmaecidos para auditoria.

================================================================================
10. API REST (endpoints)
================================================================================
Base: /api/accounts (todos requerem autenticação via sessão/cookie)

Configuração:
  GET  /config                      — Configuração global (inclui novos campos v2)
  PUT  /config                      — Salva configuração (campos novos incluídos)

Rotação:
  GET  /rotation-status             — Status atual de rotação por instância
  GET  /rotation-history            — Histórico (?limit=50)
  POST /rotation-trigger/:id        — Dispara rotação manual para instância :id

Sistema e Saúde:
  GET  /system-health               — Status consolidado do sistema:
                                      { status, flags, pool, rotation_metrics,
                                        instances[], watchdog_alerts[] }
  POST /system-flags                — Atualiza flags de modo de operação
    Body (todos opcionais):
      { emergency_mode?: boolean,
        readonly_recovery_mode?: boolean,
        rotation_paused?: boolean,
        smart_cooldown?: boolean,
        stability_weight?: number }

Watchdog:
  GET  /watchdog-alerts             — Lista alertas (?open=true, ?limit=50)
  POST /watchdog-alerts/:id/resolve — Resolve alerta específico

Contas (CRUD):
  GET  /                            — Lista contas (?instanceId, ?state, ?search)
  POST /                            — Cria conta
  PUT  /:id                         — Atualiza conta
  DELETE /:id                       — Remove conta
  POST /:id/action                  — Ação: rotate, refresh, relogin, quarantine,
                                      unquarantine, release_lock, set_state
  GET  /logs                        — Logs de eventos (?accountId, ?instanceId,
                                      ?type, ?limit)
  GET  /pool-by-instance            — Resumo do pool por instância

================================================================================
11. TABELAS DO BANCO DE DADOS
================================================================================

rotation_history
  id              SERIAL PRIMARY KEY
  instance_id     INT (FK instances)
  old_account_id  INT NULL (FK accounts)
  new_account_id  INT NULL (FK accounts)
  reason          TEXT (RotationReason)
  result          TEXT ('success','failover','rollback','aborted')
  duration_ms     INT
  detail          TEXT
  rotated_at      TIMESTAMPTZ DEFAULT NOW()

rotation_memory  (anti-pingpong persistente)
  id              SERIAL PRIMARY KEY
  instance_id     INT NOT NULL
  account_id      INT NOT NULL
  last_used_at    TIMESTAMPTZ NOT NULL
  UNIQUE(instance_id, account_id)

watchdog_alerts
  id              SERIAL PRIMARY KEY
  instance_id     INT NULL (FK instances ON DELETE SET NULL)
  alert_type      TEXT (orphan_lock | rotation_loop | excessive_failovers |
                        account_oscillation | pool_empty | pool_critical |
                        high_rollback_rate)
  severity        TEXT (critical | high | medium | low)
  detail          TEXT NULL
  resolved        BOOLEAN DEFAULT FALSE
  created_at      TIMESTAMPTZ DEFAULT NOW()
  resolved_at     TIMESTAMPTZ NULL

accounts_config  (campos adicionados em v2.0)
  emergency_mode          BOOLEAN DEFAULT FALSE
  readonly_recovery_mode  BOOLEAN DEFAULT FALSE
  rotation_paused         BOOLEAN DEFAULT FALSE
  smart_cooldown          BOOLEAN DEFAULT TRUE
  stability_weight        INTEGER DEFAULT 20

================================================================================
12. FLUXO OPERACIONAL RESUMIDO
================================================================================

[Health Monitor — cada 30s]
  └► syncSystemFlagsFromDb()         ← re-lê flags do BD (sem restart)
  └► runHealthCheck()
      ├─ Se readonly/paused/watchdog_paused → skip
      ├─ Busca contas ACTIVE por instância
      ├─ Para cada conta ativa: verifica max_continuous_ms, health_score, estado
      └─ Se trigger necessário → triggerRotation(instanceId, reason, oldId)

[Watchdog — cada 60s]
  └► runWatchdogChecks()
      ├─ orphan_lock        → libera lock + alerta high
      ├─ rotation_loop      → setWatchdogPause(true) + alerta critical
      ├─ excessive_failovers→ setWatchdogPause(true) + alerta critical
      ├─ account_oscillation→ alerta high
      ├─ pool_empty         → alerta critical
      ├─ pool_critical      → alerta high
      └─ high_rollback_rate → alerta high

[triggerRotation(instanceId, reason, oldId, isFailover=false)]
  ├─ Verifica bloqueios: readonly > emergency > paused|watchdog_paused
  ├─ Fila por instância (uma rotação por vez por instância)
  └─ executeRotation()
      ├─ [1] Seleciona candidato (anti-pingpong + stability score)
      ├─ [2] Verifica anti-pingpong duplo (memória + BD)
      ├─ [3] Lock otimista (CAS na tabela accounts)
      ├─ [4] Rollback guard
      ├─ [5] Ativa nova conta
      ├─ [6] Libera antiga com smart cooldown
      ├─ [7] Registra anti-pingpong (memória + BD)
      ├─ [8] Insere rotation_history
      └─ [9] Notifica e loga conclusão

================================================================================
13. GUIA DE TROUBLESHOOTING
================================================================================

SINTOMA: Rotações não acontecem mesmo com auto_rotation=true
  Verificar:
    1. Tab 🏥 Sistema → algum modo de bloqueio ativo? (Emergency/Readonly/Paused)
    2. Badge "Watchdog Pause" visível no topo do painel?
    3. Pool com contas usáveis? (Métricas de Pool → Usáveis = 0 = crítico)
    4. Logs do servidor: "[auto-rotator] bloqueado:" indica qual flag está ativa

SINTOMA: Muitos failovers em pouco tempo
  Verificar:
    1. 🏥 Sistema → Alertas → "Failovers Excessivos" presente?
    2. Pool tem contas com tokens válidos?
    3. Conexão Discord estável? Verificar logs do worker
    4. Se watchdog_paused ativo: aguardar 60s para o Watchdog retomar

SINTOMA: Pool entrando em quarentena rapidamente
  Verificar:
    1. Taxa de rollbacks alta? → problema de concorrência ou DB
    2. Contas com consecutive_failures elevado → revisar e atualizar tokens
    3. Smart Cooldown aplicando cooldowns muito longos → reduzir
       cooldown_after_use_ms na configuração

SINTOMA: Alerta "Loop de Rotação" e watchdog pausou
  O que aconteceu: >5 rotações/hora em uma instância.
  Ação:
    1. Investigar causa: tokens ruins? health_score baixo?
    2. Corrigir contas problemáticas
    3. Watchdog retoma automaticamente em 60s
    4. Resolver o alerta no painel

SINTOMA: "Somente Leitura" ativo e impossível desativar
  Solução direta no BD:
    UPDATE accounts_config SET readonly_recovery_mode = FALSE WHERE id = 1;
  Depois reiniciar o servidor para re-sincronizar flags em memória, OU
  aguardar até 30s para o próximo ciclo de syncSystemFlagsFromDb().

================================================================================
14. EXEMPLOS DE CENÁRIOS
================================================================================

Cenário A: Manutenção programada de 5 minutos
  1. 🏥 Sistema → ative "Rotação Pausada"
  2. Realize a manutenção
  3. 🏥 Sistema → desative "Rotação Pausada"
  → Failovers continuam funcionando durante a manutenção

Cenário B: Conta com token inválido causando loops
  1. Watchdog detecta rotation_loop → pausa automaticamente
  2. Alerta aparece em 🏥 Sistema → Alertas do Watchdog
  3. Vá em 👤 Contas, filtre pela conta problemática
  4. Mude o estado para INVALID_TOKEN ou MANUAL_ACTION_REQUIRED
  5. Atualize o token se disponível
  6. Watchdog resume em 60s → resolver alerta no painel

Cenário C: Pool crítico (menos de 20% usável)
  1. Alerta "Pool Crítico" (severity: high) criado pelo Watchdog
  2. Status muda para DEGRADADO ou CRÍTICO no painel
  3. Revise contas em quarentena/cooldown: alguma pode ser liberada?
  4. Se necessário: adicionar novas contas via 👤 Contas → + Nova Conta

Cenário D: Suspeita de banimento em massa
  1. Ative "Modo Emergência" (permite só failovers para manter sessões vivas)
  2. Analise logs: que tipo de atividade causou o banimento?
  3. Identifique e marque contas afetadas como BANNED
  4. Desative "Modo Emergência" para retomar rotações normais

================================================================================
FIM DO DOCUMENTO — Imperiuns Bot v2.0 Stability & Observability Layer
================================================================================
