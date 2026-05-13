================================================================================
  README — ABA CONTAS (EmpireBot)
================================================================================

--------------------------------------------------------------------------------
OBJETIVO DA ABA CONTAS
--------------------------------------------------------------------------------

A aba CONTAS é o gerenciador centralizado de todas as contas Discord usadas pelo
EmpireBot. Ela funciona como:

  - Account Manager:        Cadastro, edição e remoção de contas.
  - Session Orchestrator:   Coordena qual conta está ativa em qual instância.
  - Health Controller:      Calcula a saúde de cada conta em tempo real.
  - Auto Recovery System:   Detecta falhas e aciona cooldown/quarentena.
  - Rotation Manager:       Decide quando e para qual conta rotacionar.

A página NÃO duplica as métricas de Entradas, Filas, Partidas e Msgs que já
aparecem no dashboard principal das instâncias (BOT1, BOT2).

--------------------------------------------------------------------------------
COMO CADASTRAR UMA CONTA
--------------------------------------------------------------------------------

1. Acesse o menu "👤 Contas" no topo do painel.
2. Clique em "+ Nova conta".
3. Preencha os campos:

   OBRIGATÓRIO:
   - Nome / Nickname: nome interno para identificar a conta (ex: "Conta 01").

   OPCIONAIS (mas recomendados):
   - E-mail: e-mail da conta Discord.
   - Token: token de autenticação da conta Discord (colar diretamente).
   - Instância vinculada: BOT1, BOT2 ou "Nenhuma" (pool global).

   CONFIGURAÇÕES AVANÇADAS:
   - Auto-rotação: permite que o sistema troque esta conta automaticamente.
   - Auto-refresh: o sistema tenta renovar o token/sessão automaticamente.
   - Auto-relogin: usa e-mail/senha como fallback de último recurso.
   - Modo automático de tempo de uso: o bot decide quando trocar a conta.
   - Tempo mínimo / máximo de uso: define janela de permanência da conta.
   - Notas: campo livre para observações.

4. Clique em "Salvar".

--------------------------------------------------------------------------------
COMO FUNCIONA: EMAIL + TOKEN
--------------------------------------------------------------------------------

Uma conta pode funcionar apenas com:
  - E-mail + Token (recomendado e suficiente)

O campo "senha" é OPCIONAL. Ele só é utilizado se "Auto-relogin" estiver ativado
e apenas como fallback de último recurso — o sistema nunca tenta fazer login
automático via senha como método principal, pois o Discord pode exigir captcha,
verificação por e-mail, 2FA ou outros challenges de segurança.

O fluxo de recuperação preferido é sempre:
  1. Reutilizar a sessão atual.
  2. Reutilizar cookies da sessão.
  3. Renovar (refresh) o token via sessão já autenticada.
  4. Usar e-mail/senha apenas se nenhuma das opções acima funcionar.

Se ocorrer um challenge de segurança:
  - A conta é marcada automaticamente como NEEDS_VERIFICATION ou LOGIN_CHALLENGE.
  - O sistema para de tentar logar automaticamente (sem loop infinito).
  - A conta fica aguardando ação manual.

--------------------------------------------------------------------------------
INSTÂNCIA VINCULADA
--------------------------------------------------------------------------------

Ao cadastrar ou editar uma conta, você pode vinculá-la a uma instância:

  - Nenhuma    → conta global (disponível para qualquer instância).
  - BOT1       → conta exclusiva do BOT1.
  - BOT2       → conta exclusiva do BOT2.
  - (outras)   → qualquer outra instância cadastrada.

Comportamento:
  - Conta vinculada ao BOT1: só pode ser usada pelo BOT1.
  - Conta vinculada ao BOT2: só pode ser usada pelo BOT2.
  - Conta sem vínculo: pode ser usada por qualquer instância disponível.

--------------------------------------------------------------------------------
DIFERENÇA ENTRE CONTA GLOBAL E CONTA VINCULADA
--------------------------------------------------------------------------------

  CONTA GLOBAL (instância = Nenhuma):
  - Fica no pool compartilhado.
  - Qualquer instância pode usá-la quando precisar de uma conta.
  - Útil para ter reservas que qualquer bot pode consumir.

  CONTA VINCULADA (instância = BOT1 ou BOT2):
  - Pertence exclusivamente àquela instância.
  - Outra instância nunca poderá usar essa conta.
  - Útil para separar contas por bot e manter controle preciso.

--------------------------------------------------------------------------------
POOL POR INSTÂNCIA
--------------------------------------------------------------------------------

Quando uma instância precisa de uma conta (para rotação, recuperação etc.),
a ordem de prioridade de seleção é:

  1. Contas vinculadas à própria instância (pool exclusivo).
  2. Contas globais disponíveis (sem vínculo, sem lock ativo).
  3. Nunca usar conta vinculada a OUTRA instância.

Isso garante que BOT1 e BOT2 nunca competem pela mesma conta exclusiva.

--------------------------------------------------------------------------------
COMO FUNCIONA A ROTAÇÃO
--------------------------------------------------------------------------------

O sistema rotaciona contas automaticamente quando:
  - O health score cai abaixo do mínimo configurado.
  - A conta atinge o tempo máximo de uso contínuo.
  - Ocorre rate limit, shadow limit ou falha de token.
  - A conta acumula muitas falhas consecutivas.

Estratégias disponíveis (configuráveis na aba "Configurações"):
  - Sequential:          Rotaciona na ordem cadastrada.
  - Random:              Escolhe aleatoriamente.
  - Weighted Health:     Prioriza contas mais saudáveis (RECOMENDADO).
  - Least Recently Used: Prioriza contas menos utilizadas recentemente.

Ao rotacionar:
  1. A conta atual vai para estado COOLING.
  2. O sistema seleciona a melhor conta disponível.
  3. O token da nova conta é aplicado na instância.
  4. Um lock temporário é criado para evitar conflitos.
  5. Logs são registrados.

--------------------------------------------------------------------------------
COMO FUNCIONA O HEALTH SCORE
--------------------------------------------------------------------------------

Cada conta recebe um score de 0 a 100, calculado com os seguintes pesos:

  40%  Estabilidade da sessão   (estado atual da conta)
  25%  Ausência de erros        (falhas consecutivas e totais)
  20%  Saúde da sessão          (tempo desde a última atividade)
  10%  Disponibilidade          (cooldown, quarentena ativa?)
   5%  Status do token          (conectado, rate_limited, inválido?)

Classificação por tier:

  S Tier → 90% ou mais   (cor amarela — excelente)
  A Tier → 75% a 89%     (cor verde — boa)
  B Tier → 60% a 74%     (cor azul — razoável)
  C Tier → 40% a 59%     (cor âmbar — atenção)
  D Tier → abaixo de 40% (cor vermelha — problema)

O health score é recalculado automaticamente a cada 15 segundos no painel.

--------------------------------------------------------------------------------
COMO FUNCIONAM COOLDOWN E QUARENTENA
--------------------------------------------------------------------------------

  COOLDOWN:
  - Período de descanso após uso normal ou rotação.
  - A conta fica no estado COOLING durante este período.
  - Padrão: 45 minutos. Configurável nas "Configurações Globais".

  COOLDOWN PÓS-FALHA:
  - Aplicado automaticamente após uma falha.
  - Padrão: 30 minutos. Configurável nas "Configurações Globais".

  QUARENTENA:
  - Aplicada após 5 ou mais falhas consecutivas.
  - Mais longa que o cooldown normal.
  - Padrão: 60 minutos. Configurável nas "Configurações Globais".
  - A conta fica bloqueada até o fim da quarentena.
  - Após a quarentena, o estado retorna a STANDBY.

  ANTI-LOOP:
  - O sistema detecta ciclos de falha (A falha → B falha → volta A → loop).
  - Cada conta tem um contador de falhas consecutivas.
  - Ao atingir o limite, a conta entra em quarentena automática.

--------------------------------------------------------------------------------
ESTADOS DA CONTA
--------------------------------------------------------------------------------

  ACTIVE              → Conta em uso ativo.
  IDLE                → Conectada mas sem atividade.
  STANDBY             → Pronta para uso, aguardando.
  COOLING             → Em cooldown pós-uso.
  RESERVED            → Reservada para uso futuro.
  WAITING             → Aguardando recurso externo.
  REAUTH              → Necessita reautenticação.
  INVALID_TOKEN       → Token inválido ou expirado.
  NEEDS_VERIFICATION  → Discord solicitou verificação.
  LOGIN_CHALLENGE     → Challenge de segurança detectado.
  MANUAL_ACTION_REQ   → Requer ação manual do operador.
  LIMITED             → Conta com limitações ativas.
  ERROR               → Erro genérico.
  DEAD                → Conta morta (falha crítica).
  BANNED              → Conta banida pelo Discord.

--------------------------------------------------------------------------------
COMO FUNCIONAM OS LOGS
--------------------------------------------------------------------------------

Todos os eventos da conta são registrados na aba "📋 Logs":

  created          → Conta criada.
  activated        → Conta ativada.
  deactivated      → Conta pausada manualmente.
  state_change     → Mudança de estado (ex: STANDBY → ACTIVE).
  rotation         → Rotação executada.
  failure          → Falha registrada.
  reset            → Contadores resetados.
  instance_link    → Vínculo de instância alterado.
  token_applied    → Token aplicado em uma instância.
  lock_acquired    → Lock adquirido por uma instância.
  lock_released    → Lock liberado.

Filtros disponíveis nos logs:
  - Por conta (nome)
  - Por tipo de evento
  - Por busca livre de texto
  - Limpar filtros

Os logs são atualizados a cada 10 segundos automaticamente.

--------------------------------------------------------------------------------
TOKENS INDEPENDENTES POR INSTÂNCIA
--------------------------------------------------------------------------------

Cada instância (BOT1, BOT2) tem seu próprio pool de tokens completamente
independente. Isso significa:

  - Remover um token do BOT1 NÃO remove o mesmo token do BOT2.
  - O mesmo valor de token pode existir em BOT1 e BOT2 como registros separados.
  - Cada instância gerencia sua própria lista de tokens ativos.
  - Edições em uma instância não afetam a outra.

Ao ATIVAR uma conta que tem token próprio e instância vinculada:
  1. O sistema verifica se o token já está no pool daquela instância.
  2. Se não estiver, adiciona automaticamente ao pool da instância.
  3. O token NÃO é adicionado em outras instâncias.

Na aba principal (ConfigForm de cada instância), ao remover um token:
  - O token é removido APENAS da lista daquela instância.
  - Outras instâncias continuam com seus tokens intactos.

--------------------------------------------------------------------------------
LOCK DE CONTA (PREVENÇÃO DE CONFLITO)
--------------------------------------------------------------------------------

Quando uma conta é ativada, ela recebe um LOCK automático de 2 horas.

Campos do lock:
  - account_lock:       true/false (lock ativo).
  - locked_by_instance: ID da instância que está usando a conta.
  - locked_at:          Quando o lock foi criado.
  - lock_expires_at:    Quando o lock expira automaticamente.

Regras:
  - Uma conta com lock ativo só pode ser usada pela instância que detém o lock.
  - Se outra instância tentar usar a conta, recebe um erro de conflito.
  - Se a instância parar de responder, o lock expira automaticamente.
  - É possível liberar o lock manualmente clicando em "Reset" no card da conta.

--------------------------------------------------------------------------------
CUIDADOS IMPORTANTES DE USO
--------------------------------------------------------------------------------

1. NUNCA ative a mesma conta em duas instâncias simultaneamente.
   O sistema previne isso via lock, mas fique atento.

2. Contas marcadas como BANNED ou DEAD devem ser removidas.
   Continuar tentando usá-las pode gerar problemas.

3. O campo "senha" é OPCIONAL e de alto risco.
   Só ative "Auto-relogin" se necessário. O Discord pode detectar logins
   automáticos e acionar verificações que bloqueiam a conta permanentemente.

4. Tokens são armazenados em texto puro no banco de dados.
   Proteja o acesso ao servidor e ao banco de dados.

5. Contas em NEEDS_VERIFICATION ou LOGIN_CHALLENGE precisam de ação manual.
   O sistema não vai tentar resolver automaticamente — acesse o Discord
   manualmente para resolver o challenge antes de reativar a conta.

6. O sistema de cooldown existe para proteger as contas.
   Não force o uso de contas em cooldown sem necessidade.

--------------------------------------------------------------------------------
EXEMPLOS PRÁTICOS
--------------------------------------------------------------------------------

EXEMPLO 1: Conta dedicada ao BOT1 com token manual
  - Nickname: "Conta BOT1 #1"
  - Email: conta1@email.com
  - Token: [colar o token do Discord]
  - Instância: BOT1
  - Auto-rotação: Sim
  - Ao ativar: token é automaticamente adicionado ao pool do BOT1.

EXEMPLO 2: Conta de reserva global
  - Nickname: "Reserva 01"
  - Email: reserva01@email.com
  - Token: [colar o token do Discord]
  - Instância: Nenhuma
  - Auto-rotação: Sim
  - Comportamento: qualquer instância pode usar esta conta quando precisar.

EXEMPLO 3: Pool de 10 contas para 2 instâncias
  - 5 contas vinculadas ao BOT1
  - 5 contas vinculadas ao BOT2
  - Máx. contas ativas (configuração): 2 por instância
  - Resultado: cada bot roda com 1 conta ativa e tem 4 de reserva própria.

EXEMPLO 4: Remover token apenas do BOT1 sem afetar o BOT2
  - Na aba principal do painel, acesse a aba do BOT1.
  - Na seção "Selecionar tokens", clique em "Remover".
  - Marque o token desejado e confirme.
  - Resultado: token removido APENAS do BOT1. O BOT2 continua intacto.

--------------------------------------------------------------------------------
POOL POR INSTÂNCIA — ABA 🏊 POOL
--------------------------------------------------------------------------------

A aba "🏊 Pool" mostra, em tempo real, o estado do pool de contas para cada
instância cadastrada. Ela responde à pergunta central:

  "Quantas contas cada bot tem disponíveis AGORA para entrar em fila?"

--------------------------------------------------------------------------------
O QUE SÃO CONTAS GLOBAIS
--------------------------------------------------------------------------------

Contas globais são contas sem instância vinculada (campo "Instância" = Nenhuma).

  - Qualquer instância pode usar uma conta global, desde que esteja disponível.
  - São compartilhadas entre todos os bots.
  - Aparecem no pool de TODAS as instâncias.

Exemplo prático:
  - Você tem 10 contas globais.
  - BOT1 e BOT2 ambos enxergam essas 10 contas no pool.
  - Mas uma conta só pode ser usada por UM bot por vez (lock ativo).

--------------------------------------------------------------------------------
O QUE SÃO CONTAS EXCLUSIVAS
--------------------------------------------------------------------------------

Contas exclusivas são contas vinculadas a uma instância específica
(campo "Instância" = BOT1, BOT2, etc).

  - Só aparecem no pool da instância à qual estão vinculadas.
  - Nenhuma outra instância pode usá-las.
  - Identificadas com badge "EXCLUSIVA" na lista expandida.

Exemplo prático:
  - "Conta BOT1 #1" está vinculada ao BOT1.
  - Ela aparece APENAS no pool do BOT1.
  - O BOT2 nunca verá ou usará essa conta.

--------------------------------------------------------------------------------
COMO CALCULAR O POOL DE UMA INSTÂNCIA
--------------------------------------------------------------------------------

Pool de BOT1 = Contas vinculadas ao BOT1 + Contas globais disponíveis

Um conta é UTILIZÁVEL (conta no "usáveis") se:
  ✓ Está no pool da instância (exclusiva ou global)
  ✓ Estado não é DEAD, BANNED, INVALID_TOKEN, NEEDS_VERIFICATION,
    LOGIN_CHALLENGE ou MANUAL_ACTION_REQUIRED
  ✓ Não está em cooldown (cooldown_until > agora)
  ✓ Não está em quarentena (quarantine_until > agora)
  ✓ Não está bloqueada por outra instância
  ✓ Health score ≥ mínimo configurado (padrão: 40%)

--------------------------------------------------------------------------------
MOTIVOS DE INDISPONIBILIDADE
--------------------------------------------------------------------------------

Cada conta indisponível mostra o(s) motivo(s) na lista expandida:

  "Bloqueada por BOT2"
    → Conta com lock ativo adquirido pelo BOT2. Será liberada automaticamente
      quando o lock expirar (padrão: 2 horas após ativação).

  "Cooldown até HH:MM"
    → Conta em período de descanso. Ficará disponível ao fim do cooldown.

  "Quarentena até HH:MM"
    → Conta com muitas falhas consecutivas, em quarentena forçada.
      Ficará disponível ao fim da quarentena.

  "Estado: DEAD / BANNED / INVALID_TOKEN / ..."
    → Estado crítico que impede uso imediato.
    → DEAD: conta com falha crítica irrecuperável.
    → BANNED: conta banida pelo Discord.
    → INVALID_TOKEN: token expirado ou inválido.
    → NEEDS_VERIFICATION: Discord solicitou verificação manual.
    → LOGIN_CHALLENGE: challenge de segurança ativo.
    → MANUAL_ACTION_REQUIRED: requer intervenção do operador.

  "Health baixo (X%)"
    → Health score abaixo do mínimo configurado.
    → Configure o mínimo em "⚙️ Configurações" → "Health mínimo para rotação".

--------------------------------------------------------------------------------
COMO INTERPRETAR OS CARDS
--------------------------------------------------------------------------------

Cada card de instância exibe:

  [Nome da Instância]                         [X usáveis]
  ──────────────────────────────────────────────────────
  Exclusivas   │ Globais disp. │ Ativas agora
  Cooldown     │ Quarentena    │ Bloq. outra

  [Barra de health médio do pool]
  [Barra de utilização do pool (% utilizável)]

  [Melhor disponível → clique para ir ao card da conta]

  [▼ Ver todas as contas (N)]  ← expande a lista completa

Cores do contador "usáveis":
  Verde  → 2 ou mais contas utilizáveis (pool saudável)
  Âmbar  → 1 conta utilizável (atenção — pool crítico)
  Vermelho → 0 contas utilizáveis (bot sem conta para usar)

--------------------------------------------------------------------------------
FILTROS DA ABA POOL
--------------------------------------------------------------------------------

Os filtros controlam quais contas aparecem na lista expandida de cada instância:

  [Só disponíveis]  → Oculta contas indisponíveis. Mostra apenas as utilizáveis.
  [Bloqueadas]      → Mostra/oculta contas com lock de outra instância.
  [Globais]         → Mostra/oculta contas sem instância vinculada.
  [Exclusivas]      → Mostra/oculta contas vinculadas àquela instância.
  [Cooldown]        → Mostra/oculta contas em cooldown.
  [Quarentena]      → Mostra/oculta contas em quarentena.
  [Inválidas]       → Mostra/oculta contas com estado crítico (DEAD, BANNED, etc).

Os filtros NÃO afetam os contadores do card — apenas a lista expandida.

Botão [↻ Atualizar]:
  → Recalcula o pool manualmente. O pool também é calculado ao abrir a aba.

--------------------------------------------------------------------------------
BARRA DE RESUMO GLOBAL
--------------------------------------------------------------------------------

No topo da aba Pool, uma barra de 4 cards mostra os totais de TODAS as instâncias:

  Total utilizáveis    → soma de contas utilizáveis em todas as instâncias
  Em cooldown          → soma de contas em cooldown em todas as instâncias
  Em quarentena        → soma de contas em quarentena
  Bloqueadas           → soma de contas bloqueadas por outra instância

--------------------------------------------------------------------------------
MELHOR CONTA DISPONÍVEL
--------------------------------------------------------------------------------

O card destaca automaticamente a conta com maior health score entre as
utilizáveis daquela instância. Clicar no bloco verde leva ao card da conta
na aba "👤 Contas", com o nome da conta já preenchido no filtro de busca.

--------------------------------------------------------------------------------
EXEMPLO COMPLETO — INTERPRETAÇÃO DE UM CENÁRIO REAL
--------------------------------------------------------------------------------

Cenário: 2 bots, 8 contas no total.

  Contas:
  - "A01" → vinculada BOT1, estado ACTIVE,  health 88%
  - "A02" → vinculada BOT1, estado COOLING, health 60%  ← em cooldown
  - "A03" → vinculada BOT2, estado STANDBY, health 95%
  - "A04" → vinculada BOT2, estado ACTIVE,  health 72%
  - "G01" → global,         estado STANDBY, health 91%  ← lock por BOT1
  - "G02" → global,         estado STANDBY, health 82%
  - "G03" → global,         estado DEAD,    health  0%
  - "G04" → global,         estado STANDBY, health 45%

  Pool do BOT1:
  - Exclusivas: A01, A02 (2)
  - Globais no pool: G01, G02, G03, G04 (4)
  - Utilizáveis: A01 (ativa, 88%), G02 (standby, 82%), G04 (45%) = 3
  - Não utilizáveis:
    → A02: cooldown
    → G01: bloqueada pelo BOT1 (ele mesmo tem o lock — ainda conta como lock)
    → G03: DEAD
  - Health médio: (88+60+91+82+0+45) / 6 = 61%
  - Melhor disponível: A01 (88%)

  Pool do BOT2:
  - Exclusivas: A03, A04 (2)
  - Globais no pool: G01, G02, G03, G04 (4) — G01 tem lock do BOT1!
  - Utilizáveis: A03 (95%), A04 (72%), G02 (82%), G04 (45%) = 4
  - Não utilizáveis:
    → G01: bloqueada por BOT1
    → G03: DEAD
  - Melhor disponível: A03 (95%)

--------------------------------------------------------------------------------
AUTO-ROTAÇÃO AUTOMÁTICA DE CONTAS
--------------------------------------------------------------------------------

O sistema de Auto-Rotação substitui a conta ativa de uma instância automaticamente,
sem intervenção manual, sempre que a conta atual apresentar degradação ou atingir
os limites configurados.

  GATILHOS QUE ATIVAM A AUTO-ROTAÇÃO:
  - Health score cai abaixo do mínimo configurado.
  - Tempo máximo de uso contínuo é atingido.
  - Rate limit grave detectado.
  - Sessão morreu (heartbeat falhou).
  - Token invalidado.
  - Shadow limit detectado.
  - Falhas consecutivas atingem o limite configurado.
  - Conta entra em quarentena.
  - Conta entra em estado crítico (ERROR, DEAD, BANNED etc).

  QUANDO A ROTAÇÃO NÃO OCORRE:
  - Conta ainda está dentro do tempo mínimo obrigatório de uso.
  - Não há conta saudável disponível no pool.
  - Instância está em lock operacional.
  - Já existe uma rotação em andamento para essa instância.
  - Sistema está em Safe Rotation Mode aguardando validação.

--------------------------------------------------------------------------------
MODO AUTOMÁTICO DE TEMPO
--------------------------------------------------------------------------------

Se nenhum tempo mínimo/máximo de uso estiver configurado para a conta,
o sistema decide automaticamente o melhor momento de rotação com base em:

  - Health score atual da conta.
  - Estabilidade da sessão.
  - Tempo contínuo de uso acumulado.
  - Histórico de uso da conta.
  - Taxa de erros recentes.
  - Risco operacional calculado.
  - Qualidade do pool disponível naquele momento.

  Ative este modo na tela de edição da conta com a opção:
  "Modo automático de tempo de uso".

--------------------------------------------------------------------------------
SELEÇÃO DA MELHOR CONTA NA ROTAÇÃO
--------------------------------------------------------------------------------

Ao escolher qual conta vai substituir a atual, o sistema avalia:

  CRITÉRIOS DE SELEÇÃO (em ordem de prioridade):
  1. Maior health score.
  2. Menor tempo de uso recente.
  3. Menor quantidade de falhas acumuladas.
  4. Ausência de cooldown ativo.
  5. Ausência de lock de outra instância.
  6. Ausência de quarentena.
  7. Prioridade para contas exclusivas da própria instância.
  8. Fallback para contas globais disponíveis.

  CONTAS QUE NUNCA SÃO SELECIONADAS:
  - Abaixo do health score mínimo configurado.
  - Em cooldown.
  - Em quarentena.
  - Bloqueadas por lock.
  - Com estado INVALID_TOKEN, DEAD, BANNED, NEEDS_VERIFICATION, LOGIN_CHALLENGE.
  - Utilizadas recentemente pela mesma instância (anti-pingpong ativo).

--------------------------------------------------------------------------------
SAFE ROTATION MODE (ROTAÇÃO SEGURA)
--------------------------------------------------------------------------------

O Safe Rotation Mode valida a nova conta ANTES de realizar a troca efetiva.

  Fluxo de validação:
  1. Validar token da nova conta.
  2. Validar heartbeat (conta responde ao Discord).
  3. Validar sessão ativa.
  4. Se TODAS as validações passarem:
     → Remover conta antiga da instância.
     → Ativar nova conta.
  5. Se QUALQUER validação falhar:
     → Abortar rotação completamente.
     → Restaurar estado anterior da instância.
     → Registrar rollback nos logs.
     → Manter instância operacional com a conta anterior.

  Princípio: Estabilidade acima de velocidade.
  Nunca trocar por uma conta que ainda não foi validada.

--------------------------------------------------------------------------------
ROTAÇÃO TRANSACIONAL (FLUXO ATÔMICO)
--------------------------------------------------------------------------------

A troca de conta funciona como uma transação — ou tudo ocorre com sucesso,
ou nada é alterado. O fluxo completo é:

  1. Selecionar a melhor conta disponível.
  2. Criar lock temporário na conta selecionada.
  3. Validar sessão e token (Safe Rotation Mode).
  4. Aplicar token da nova conta na instância.
  5. Validar heartbeat pós-aplicação.
  6. Marcar nova conta como ACTIVE.
  7. Liberar conta anterior (remover do estado ACTIVE).
  8. Aplicar cooldown automático na conta anterior.
  9. Registrar todos os eventos nos logs operacionais.

  SE QUALQUER ETAPA FALHAR:
  - Rollback completo de todas as alterações.
  - Conta anterior é restaurada.
  - Locks temporários são liberados.
  - Erro detalhado é registrado.
  - A instância nunca fica sem conta ativa.

--------------------------------------------------------------------------------
COOLDOWN INTELIGENTE PÓS-ROTAÇÃO
--------------------------------------------------------------------------------

Ao final de uma rotação, a conta que saiu de uso entra automaticamente em cooldown:

  ROTAÇÃO NORMAL:
  - Aplica cooldown padrão (configurável em "Configurações Globais").
  - Padrão: 45 minutos.

  ROTAÇÃO POR FALHA OU RATE LIMIT:
  - Aplica cooldown pós-falha (mais longo).
  - Padrão: 30 minutos extras além do cooldown normal.

  ROTAÇÃO POR QUARENTENA:
  - Aplica quarentena ao invés de cooldown.
  - Padrão: 60 minutos. Configurável.

  O sistema ajusta o tempo de cooldown dinamicamente conforme o motivo da saída,
  protegendo a conta contra sobrecarga imediata após incidentes.

--------------------------------------------------------------------------------
FILA DE ROTAÇÃO (SERIALIZAÇÃO)
--------------------------------------------------------------------------------

O sistema mantém uma fila interna de operações de rotação por instância.

  Regras:
  - Apenas UMA rotação por instância pode ocorrer ao mesmo tempo.
  - Novas solicitações de rotação aguardam na fila.
  - Operações simultâneas são serializadas para evitar race conditions.
  - Múltiplas trocas paralelas na mesma instância são impedidas.

  Isso garante consistência total: o banco de dados nunca fica em estado
  inconsistente por duas rotações tentando ocorrer ao mesmo tempo.

--------------------------------------------------------------------------------
ANTI-PINGPONG
--------------------------------------------------------------------------------

O anti-pingpong evita que o sistema fique trocando repetidamente entre as
mesmas contas em ciclo (A → B → A → B → ...).

  Mecanismo:
  - Cada instância mantém um histórico recente de contas utilizadas.
  - Contas utilizadas recentemente recebem uma penalidade temporária.
  - Cooldown inteligente impede reutilização imediata.
  - Janela anti-pingpong: período configurável de exclusão por uso recente.

  Exemplo prático:
  - BOT1 usa conta A por 2 horas e rotaciona para conta B.
  - Conta A entra em cooldown.
  - Mesmo que conta A saia do cooldown antes de conta B falhar,
    o anti-pingpong impede que BOT1 volte imediatamente para conta A,
    garantindo que outras contas do pool tenham chance de uso.

--------------------------------------------------------------------------------
AUTO-FAILOVER
--------------------------------------------------------------------------------

Se uma conta morrer inesperadamente (queda de sessão, token inválido repentino
ou heartbeat sem resposta), o sistema aciona o auto-failover imediatamente:

  1. Detecta a falha crítica da conta ativa.
  2. Seleciona imediatamente a próxima conta saudável disponível.
  3. Aplica fallback automático sem aguardar o ciclo normal de rotação.
  4. Mantém a instância online sem interrupção perceptível.
  5. Registra o evento de failover nos logs com causa e conta selecionada.

  O failover é mais rápido que a rotação normal — prioriza disponibilidade.

--------------------------------------------------------------------------------
LOGS DA AUTO-ROTAÇÃO
--------------------------------------------------------------------------------

Todos os eventos da auto-rotação são registrados automaticamente na aba Logs:

  auto_rotation_started    → Rotação automática iniciada.
  rotation_reason          → Motivo da rotação (health baixo, timeout, falha etc).
  account_selected         → Conta selecionada para substituição.
  validation_approved      → Validação da nova conta aprovada (Safe Mode).
  validation_failed        → Validação falhou — rotação abortada.
  rollback_executed        → Rollback realizado — estado anterior restaurado.
  cooldown_applied         → Cooldown aplicado na conta que saiu.
  failover_executed        → Auto-failover acionado por falha inesperada.
  lock_created             → Lock temporário criado na nova conta.
  lock_released            → Lock temporário liberado.
  heartbeat_validated      → Heartbeat da nova conta validado com sucesso.
  anti_pingpong_applied    → Conta excluída por janela anti-pingpong.

--------------------------------------------------------------------------------
INDICADORES VISUAIS DA AUTO-ROTAÇÃO (PAINEL)
--------------------------------------------------------------------------------

O painel exibe indicadores em tempo real para cada instância:

  Auto Rotation ON/OFF      → Mostra se a auto-rotação está habilitada.
  Rotation In Progress      → Indica que uma troca está ocorrendo agora.
  Last Rotation Reason      → Motivo da última rotação executada.
  Next Eligible Rotation    → Quando a próxima rotação pode ocorrer.
  Cooldown Remaining        → Tempo restante de cooldown da conta anterior.
  Failover Active           → Indica se a instância está em modo failover.

  TIMELINE DE ROTAÇÕES:
  Cada instância exibe um histórico visual das últimas rotações realizadas,
  mostrando: conta anterior → conta nova, motivo, timestamp, e resultado
  (sucesso, rollback ou failover).

--------------------------------------------------------------------------------
EXEMPLOS PRÁTICOS DE TROCA AUTOMÁTICA
--------------------------------------------------------------------------------

EXEMPLO 1: Health Score caiu abaixo do mínimo
  - BOT1 usa "Conta A" (health cai de 80% → 35%).
  - Mínimo configurado: 40%.
  - Sistema detecta health abaixo do mínimo.
  - Inicia rotação → seleciona "Conta B" (health 87%).
  - Valida token e heartbeat da Conta B (Safe Mode).
  - Aplica Conta B no BOT1. Conta A entra em cooldown.
  - Log: "auto_rotation_started → health_below_minimum → account_selected: Conta B".

EXEMPLO 2: Tempo máximo de uso atingido
  - BOT2 usa "Conta C" por 3 horas. Máximo configurado: 2 horas.
  - Sistema detecta tempo excedido.
  - Rotação agendada → aguarda fila de rotação.
  - Seleciona "Conta D" (maior health disponível, sem cooldown).
  - Anti-pingpong verifica: "Conta D" não foi usada recentemente → aprovada.
  - Troca executada. Conta C entra em cooldown de 45 minutos.

EXEMPLO 3: Sessão morreu inesperadamente (Failover)
  - BOT1 perde heartbeat da "Conta E" às 14:32.
  - Sistema detecta falha crítica imediatamente.
  - Auto-failover: seleciona "Conta F" (próxima disponível e saudável).
  - Troca em modo rápido sem esperar validação completa do Safe Mode.
  - BOT1 volta a operar em segundos. Conta E entra em quarentena.
  - Log: "failover_executed → session_died → new_account: Conta F".

EXEMPLO 4: Rollback por falha na validação
  - BOT2 tenta rotacionar de "Conta G" para "Conta H".
  - Safe Mode: valida token da Conta H → OK.
  - Safe Mode: valida heartbeat da Conta H → FALHOU (sem resposta).
  - Sistema aborta rotação. Conta H não é ativada.
  - Conta G permanece ativa no BOT2. Estado anterior restaurado.
  - Log: "validation_failed → heartbeat_check → rollback_executed".
  - Sistema tentará próxima conta elegível no próximo ciclo.

EXEMPLO 5: Anti-pingpong em ação
  - BOT1 usou "Conta A" por 2h, rotacionou para "Conta B".
  - 20 minutos depois, Conta B falha → rotação iniciada.
  - Pool disponível: Conta A (health 82%), Conta C (health 71%).
  - Anti-pingpong: Conta A foi usada há apenas 20 min → penalidade aplicada.
  - Sistema seleciona Conta C (71%) mesmo com health inferior ao da Conta A.
  - Resultado: ciclo de pingpong evitado. Conta A usada novamente só após
    janela anti-pingpong expirar.

--------------------------------------------------------------------------------
FIM DO README
================================================================================
