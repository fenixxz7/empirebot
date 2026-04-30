"""Gera o PDF Deep Dive (aprofundado) do projeto Imperiuns Bot."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    ListFlowable, ListItem, Preformatted,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

OUT = "output/02_deepdive_imperiuns_bot.pdf"

NAVY = colors.HexColor("#0B1A3A")
ACCENT = colors.HexColor("#2D7CFF")
SOFT = colors.HexColor("#E8EEF9")
CODEBG = colors.HexColor("#0F172A")
CODEFG = colors.HexColor("#E2E8F0")
GRAY = colors.HexColor("#6B7280")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
                   fontSize=20, leading=24, textColor=NAVY, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
                   fontSize=14, leading=18, textColor=ACCENT, spaceBefore=12, spaceAfter=4)
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontName="Helvetica-Bold",
                   fontSize=11.5, leading=15, textColor=NAVY, spaceBefore=8, spaceAfter=3)
P  = ParagraphStyle("P", parent=styles["BodyText"], fontName="Helvetica",
                   fontSize=10.2, leading=14.5, alignment=TA_JUSTIFY, spaceAfter=5)
PB = ParagraphStyle("PB", parent=P, fontName="Helvetica-Bold")
SUB = ParagraphStyle("SUB", parent=P, fontSize=9.5, textColor=GRAY)
CODE = ParagraphStyle("CODE", parent=styles["Code"], fontName="Courier",
                     fontSize=8.6, leading=11, textColor=CODEFG, backColor=CODEBG,
                     leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=8,
                     borderPadding=6)


def hr():
    t = Table([[""]], colWidths=[17 * cm], rowHeights=[0.04 * cm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)]))
    return t


def callout(text, color=ACCENT):
    box = Table([[Paragraph(text, P)]], colWidths=[17 * cm])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("LINEBEFORE", (0, 0), (0, -1), 2, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return box


def code(text):
    return Preformatted(text, CODE)


def cover(story):
    story.append(Spacer(1, 4 * cm))
    story.append(Paragraph("IMPERIUNS BOT", ParagraphStyle(
        "cov", parent=H1, fontSize=32, leading=38, alignment=TA_CENTER)))
    story.append(Paragraph("Especificação Técnica Aprofundada",
                           ParagraphStyle("covsub", parent=H2, alignment=TA_CENTER, fontSize=14)))
    story.append(Spacer(1, 1 * cm))
    story.append(Paragraph("Documento 2 de 2 — <b>Deep Dive</b>",
                           ParagraphStyle("covt", parent=P, alignment=TA_CENTER, fontSize=12)))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph("Versão 1.0 · Abril/2026",
                           ParagraphStyle("covd", parent=SUB, alignment=TA_CENTER)))
    story.append(Spacer(1, 4 * cm))
    story.append(callout(
        "Este documento detalha cada fase do roadmap: arquitetura, modelos de dados, fluxos, "
        "algoritmos, regras de parsing por org, eventos do gateway, política de rate-limit, "
        "telemetria e operação. Onde fizer sentido, há pseudo-código e exemplos de schema."))
    story.append(PageBreak())


def toc(story):
    story.append(Paragraph("Sumário", H1))
    story.append(hr())
    story.append(Spacer(1, 0.3 * cm))
    items = [
        "1. Visão de Arquitetura",
        "2. Painel Web (Frontend)",
        "3. Backend / API & Autenticação",
        "4. Banco de Dados",
        "5. Worker — Núcleo do Selfbot",
        "6. Descoberta de Orgs, Categorias e Canais",
        "7. Parser de Embeds & Botões",
        "8. Motor de Filas (Round-Robin)",
        "9. Detecção de Partida",
        "10. Mensagens dentro da Partida",
        "11. Telemetria, Stats & Logs",
        "12. Rate-Limit, Erros e Resiliência",
        "13. Multi-Instância & Rotação de Tokens",
        "14. Operação, Backups e Hardening",
    ]
    for i in items:
        story.append(Paragraph(i, P))
    story.append(PageBreak())


def s1(story):
    story.append(Paragraph("1. Visão de Arquitetura", H1))
    story.append(hr())
    story.append(Paragraph(
        "O sistema é composto por três processos lógicos que podem rodar no mesmo host ou em "
        "hosts separados: <b>API/Web</b>, <b>Worker</b> e <b>Banco</b>. A comunicação em tempo real "
        "entre Worker → API → Painel é feita via WebSocket; configuração persiste em banco "
        "relacional; segredos (tokens) ficam criptografados em repouso.", P))
    story.append(Paragraph("Fluxo principal", H2))
    fluxo = [
        "1) Operador abre o painel, faz login e configura tokens, orgs, modos, mensagens e delay.",
        "2) Operador clica em Start na instância (BOT1 ou BOT2).",
        "3) API publica o evento de start e o Worker carrega a configuração.",
        "4) Worker abre uma sessão de gateway por token e descobre guilds/canais.",
        "5) O motor de filas calcula o próximo (org, modo) a entrar, respeitando limites.",
        "6) Worker clica no botão correto da fila (Entrar / Gel Normal / Jogar Normal etc.).",
        "7) Quando a partida é criada, Worker detecta o canal e envia a mensagem configurada.",
        "8) Stats e logs são empurrados para o painel em tempo real.",
    ]
    story.append(ListFlowable([ListItem(Paragraph(x, P)) for x in fluxo],
                              bulletType="1", leftIndent=14))

    story.append(Paragraph("Stack sugerida (alto nível)", H2))
    data = [
        ["Componente", "Tecnologia sugerida", "Motivo"],
        ["Frontend", "React + Vite + Tailwind", "Reproduz o tema escuro do painel atual."],
        ["Backend API", "Node.js (Fastify/Express) ou Python (FastAPI)", "WebSocket nativo e ecossistema rico."],
        ["Worker", "Node.js com cliente HTTP+WS próprio", "Acesso fino ao gateway/REST do Discord."],
        ["Banco", "PostgreSQL", "Transacional, JSONB para configs flexíveis."],
        ["Cache/Fila", "Redis (opcional)", "Buckets de rate-limit e pub/sub entre instâncias."],
    ]
    t = Table(data, colWidths=[3.6 * cm, 5.6 * cm, 7.8 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(t)
    story.append(PageBreak())


def s2(story):
    story.append(Paragraph("2. Painel Web (Frontend)", H1))
    story.append(hr())
    story.append(Paragraph(
        "Reproduz o painel “IMPERIUNS — PAINEL DE CONTROLE”. Tema escuro, cards arredondados, "
        "destaques em verde para status saudável, vermelho para Stop e azul para acentos.", P))

    story.append(Paragraph("Telas e componentes", H2))
    bullets = [
        "<b>Header de status:</b> badges “Conectado” e “Rodando”, abas de instância (BOT1/BOT2) e indicação “Instância ativa”.",
        "<b>Controle:</b> grande botão circular (Stop em vermelho quando rodando, Start em verde quando parado) com texto contextual.",
        "<b>Stats:</b> cards Entradas, Na Fila, Partidas, DMs, Uptime, com contadores em destaque e identificação do usuário Discord conectado (@handle).",
        "<b>Reset Stats:</b> botão para zerar contadores da instância sem afetar configuração.",
        "<b>Configuração:</b> textarea de tokens (até 5, um por linha), rotação em minutos, categoria (Mobile/Misto/Emulador), checkboxes de orgs (Surf, Tokio, Paris, Panda, REAL, CIPHER...), delay em segundos, modos permitidos (1x1/2x2/3x3/4x4 e variações), mensagem dentro da partida com variáveis e mensagem secundária por org.",
        "<b>Logs:</b> console rolante com no mínimo 100 linhas, níveis coloridos (INFO, WARN, ERROR), timestamp e botão Limpar.",
        "<b>Rodapé:</b> aviso de uso por conta e risco.",
    ]
    story.append(ListFlowable([ListItem(Paragraph(b, P)) for b in bullets],
                              bulletType="bullet", leftIndent=10))

    story.append(Paragraph("Variáveis suportadas nas mensagens", H2))
    story.append(code(
"{adversary_mention}   -> <@USER_ID>\n"
"{adversary_id}        -> 1234567890\n"
"{channel_name}        -> fila-958309 / partida-0\n"
"{org_name}            -> Colombia / Moreira / Gold ...\n"
"{mode}                -> 1x1 / 2x2 / 3x3 / 4x4\n"
"{format}              -> Mobile / Misto / Emulador\n"
"{value}               -> R$ 5,00\n"
    ))

    story.append(Paragraph("Mensagem secundária por org", H2))
    story.append(Paragraph(
        "Aceita formato em pares “org | mensagem”. A prioridade é por nome da org ou guild_id. "
        "Se houver match com a org da partida, sobrescreve a mensagem global.", P))
    story.append(code(
"Helipa | teste\n"
"Moreira F1 | oi {adversary_mention}\n"
"1395120020681392138 | mensagem dedicada por guild_id\n"
    ))
    story.append(PageBreak())


def s3(story):
    story.append(Paragraph("3. Backend / API & Autenticação", H1))
    story.append(hr())
    story.append(Paragraph(
        "API protegida por sessão (cookie httpOnly) com hashing de senha do operador. Toda "
        "requisição que altera configuração exige usuário autenticado.", P))
    story.append(Paragraph("Endpoints essenciais", H2))
    data = [
        ["Método", "Rota", "Descrição"],
        ["POST", "/api/auth/login", "Login do operador."],
        ["POST", "/api/auth/logout", "Encerra sessão."],
        ["GET",  "/api/instances", "Lista instâncias (BOT1, BOT2...) e status."],
        ["POST", "/api/instances/:id/start", "Inicia a instância."],
        ["POST", "/api/instances/:id/stop", "Para a instância."],
        ["POST", "/api/instances/:id/reset-stats", "Zera contadores."],
        ["GET",  "/api/config/:id", "Retorna configuração da instância."],
        ["PUT",  "/api/config/:id", "Salva configuração (tokens, orgs, modos, mensagens, delay, rotação)."],
        ["GET",  "/api/orgs", "Catálogo de orgs conhecidas."],
        ["GET",  "/api/logs/:id?since=ts", "Histórico de logs paginado."],
        ["WS",   "/ws/:id", "Stream em tempo real: stats, logs e eventos do worker."],
    ]
    t = Table(data, colWidths=[1.8 * cm, 6.2 * cm, 9 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("FONTNAME", (0, 1), (1, -1), "Courier"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(Paragraph("Eventos via WebSocket", H2))
    story.append(code(
'{"type":"stats","payload":{"entradas":1733,"naFila":7,"partidas":42,"dms":12,"uptime":34}}\n'
'{"type":"log","payload":{"ts":"21:30:43","level":"ERROR","msg":"Erro ao buscar tópicos da guild 134303478..."}}\n'
'{"type":"status","payload":{"instance":"BOT1","connected":true,"running":true,"user":"@sophyymaria"}}\n'
'{"type":"queue","payload":{"org":"Colombia","mode":"2x2","action":"join","value":"R$5,00"}}\n'
'{"type":"match","payload":{"org":"Colombia","channel":"fila-958309","adversary":"<@149...>"}}\n'
    ))
    story.append(PageBreak())


def s4(story):
    story.append(Paragraph("4. Banco de Dados", H1))
    story.append(hr())
    story.append(Paragraph("Esquema mínimo (PostgreSQL):", P))
    story.append(code(
"users(id, email, password_hash, created_at)\n"
"instances(id, user_id, name, running, created_at)\n"
"tokens(id, instance_id, ciphertext, status, last_used_at, rotation_minutes)\n"
"orgs(id, guild_id, name, category, max_queues, priority, enabled)\n"
"channels(id, org_id, name, mode, format, kind)  -- kind: 'queue' | 'match' | 'category'\n"
"queues_active(id, instance_id, token_id, org_id, channel_id, mode, joined_at)\n"
"matches(id, instance_id, token_id, org_id, channel_id, adversary_id, created_at, msg_sent)\n"
"messages(instance_id, scope, org_id NULL, body, image_url NULL)  -- scope: 'global' | 'org'\n"
"stats_daily(instance_id, day, entradas, partidas, dms)\n"
"logs(id, instance_id, ts, level, source, message)\n"
    ))
    story.append(Paragraph("Notas:", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("<b>tokens.ciphertext</b>: criptografia simétrica em repouso (chave fora do banco).", P)),
        ListItem(Paragraph("<b>orgs.max_queues</b>: limite por org (configurado, calibrado por observação).", P)),
        ListItem(Paragraph("<b>queues_active</b>: usado pelo motor para saber quantas filas o bot mantém ativas.", P)),
        ListItem(Paragraph("<b>matches.msg_sent</b>: garante idempotência de envio.", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(PageBreak())


def s5(story):
    story.append(Paragraph("5. Worker — Núcleo do Selfbot", H1))
    story.append(hr())
    story.append(Paragraph(
        "O Worker é responsável por manter conexões WebSocket com o gateway do Discord para "
        "cada token ativo, processar eventos relevantes e expor uma API interna para o motor "
        "de filas e o detector de partidas.", P))

    story.append(Paragraph("Eventos do gateway que importam", H2))
    data = [
        ["Evento", "Uso"],
        ["READY", "Identifica usuário, popula cache de guilds/canais e marca token como “Conectado”."],
        ["GUILD_CREATE / GUILD_DELETE", "Atualiza orgs disponíveis em runtime."],
        ["CHANNEL_CREATE / CHANNEL_UPDATE / CHANNEL_DELETE", "Detecta canais novos de partida e atualizações de categorias."],
        ["MESSAGE_CREATE / MESSAGE_UPDATE", "Lê embeds das filas (cards de Fila de Competição) e atualiza estado."],
        ["GUILD_MEMBER_ADD", "Pode complementar a detecção do adversário em alguns formatos."],
        ["RESUMED / RECONNECT", "Restaura estado sem perder filas ativas."],
    ]
    t = Table(data, colWidths=[5 * cm, 12 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)

    story.append(Paragraph("Sessão por token (estados)", H2))
    story.append(code(
"DISCONNECTED -> CONNECTING -> IDENTIFYING -> READY\n"
"READY -> RUNNING (recebendo eventos)\n"
"RUNNING -> RATE_LIMITED (backoff) -> RUNNING\n"
"RUNNING -> RESUMING -> RUNNING (em caso de queda)\n"
"qualquer -> INVALID (401/403, token quebrado) -> isolado e reportado\n"
    ))
    story.append(PageBreak())


def s6(story):
    story.append(Paragraph("6. Descoberta de Orgs, Categorias e Canais", H1))
    story.append(hr())
    story.append(Paragraph(
        "Para cada guild que o token participa, o Worker mapeia categorias (MOBILE, MISTO, "
        "EMULADOR) e canais cujo nome corresponde aos modos configurados.", P))
    story.append(Paragraph("Heurística de nome de canal", H2))
    story.append(code(
"Padrões aceitos (case-insensitive, com ou sem emojis/decorações):\n"
"  ^(\\d)x(\\d)-(mob|mobile|misto|emu|emulador)$\n"
"  ^(\\d)v(\\d)-(mob|mobile|misto|emu|emulador)$\n"
"\n"
"Exemplos casados: 1x1-mob, 2x2-mobile, 3x3-misto, 4x4-emu\n"
    ))
    story.append(Paragraph("Categorias", H2))
    story.append(Paragraph(
        "A categoria configurada no painel filtra quais canais o bot considera. Exemplo: ao "
        "escolher “Mobile”, o bot só atua em canais sob a categoria MOBILE de cada guild "
        "selecionada.", P))
    story.append(Paragraph("Cache e invalidação", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("Cache em memória por guild_id com TTL curto (ex.: 60s) e refresh sob demanda.", P)),
        ListItem(Paragraph("Invalidação imediata em CHANNEL_CREATE/UPDATE/DELETE da guild.", P)),
        ListItem(Paragraph("Backoff e retry no caso do erro real visto nos logs (HTTP 429 ao buscar canais/tópicos).", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(PageBreak())


def s7(story):
    story.append(Paragraph("7. Parser de Embeds & Botões", H1))
    story.append(hr())
    story.append(Paragraph(
        "Cada org publica um card de “Fila de Competição” com leves variações. O Worker precisa "
        "interpretar esses cards e identificar qual botão clicar. A solução é um conjunto de "
        "<b>adaptadores</b> com regras por org/template.", P))
    story.append(Paragraph("Modelo unificado de fila", H2))
    story.append(code(
"Queue = {\n"
"  org_id, channel_id, message_id,\n"
"  mode: '1x1' | '2x2' | '3x3' | '4x4',\n"
"  format: 'Mobile' | 'Misto' | 'Emulador',\n"
"  value: number,           // R$\n"
"  players: [user_id, ...], // pode estar vazio\n"
"  buttons: [\n"
"    { id, label, style, action }\n"
"    // ações possíveis: 'join', 'join_normal', 'join_full_ump_xm8',\n"
"    //                   'join_gel_normal', 'join_gel_inf', 'leave'\n"
"  ]\n"
"}\n"
    ))
    story.append(Paragraph("Variações observadas", H2))
    data = [
        ["Org / Template", "Botões característicos", "Observações"],
        ["Moreira (1x1 mobile)", "Gel Normal, Gel Infinito, Sair da Fila", "Distingue tipo de gel; usar action 'join_gel_normal' ou 'join_gel_inf' conforme escolha do operador."],
        ["Colombia (1x1-mob)", "Gel Normal, Gel Inf, Sair", "Mesma lógica de gel."],
        ["Colombia (2x2-mob)", "Entrar, Sair", "Card mais simples, apenas join/leave."],
        ["Gold Apostas (3x3, 4x4)", "Jogar Normal, Jogar Full UMP & XM8, Sair da Fila", "Dois sub-modos no mesmo card."],
        ["Bounty (2x2 full mobile)", "Estilo similar a Moreira", "Variante visual no embed; lógica equivalente."],
    ]
    t = Table(data, colWidths=[4.4 * cm, 5.6 * cm, 7 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.2),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(callout(
        "Diretriz: o adaptador <b>NUNCA</b> hardcoda o custom_id do botão. Ele identifica "
        "pelo <b>label</b> (com normalização) e pelo estilo (verde/cinza/vermelho), porque "
        "custom_ids podem mudar entre updates do bot da org."))
    story.append(PageBreak())


def s8(story):
    story.append(Paragraph("8. Motor de Filas (Round-Robin Org × Modo)", H1))
    story.append(hr())
    story.append(callout(
        "<b>Regra central:</b> o bot não prefere filas com player nem sem player. Ele reveza "
        "entre todas as orgs ativas e todos os modos permitidos para <b>maximizar a quantidade "
        "de filas simultâneas</b>, respeitando o limite individual de cada org."))
    story.append(Paragraph("Algoritmo (pseudo-código)", H2))
    story.append(code(
"loop:\n"
"  candidates = []\n"
"  for org in enabled_orgs:\n"
"    if active_queues[org] >= org.max_queues: continue\n"
"    for mode in allowed_modes:\n"
"      queue = pick_next_queue(org, mode)   # qualquer fila utilizável,\n"
"                                            # com ou sem player\n"
"      if queue is not None:\n"
"        candidates.append((org, mode, queue))\n"
"\n"
"  # Round-robin justo: ordena por (last_action_ts ASC) por (org, mode)\n"
"  candidates.sort(key=lambda c: last_action_ts[(c.org, c.mode)])\n"
"\n"
"  if candidates:\n"
"    org, mode, queue = candidates[0]\n"
"    click(queue.button_for(operator_choice))   # ex.: gel_normal\n"
"    active_queues[org] += 1\n"
"    last_action_ts[(org, mode)] = now()\n"
"    sleep(delay + jitter())\n"
"  else:\n"
"    sleep(short_idle)\n"
    ))
    story.append(Paragraph("Liberação de slot", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("Quando a fila vira partida (canal de match criado), o slot é liberado.", P)),
        ListItem(Paragraph("Quando a fila é cancelada/expirada, o slot também é liberado.", P)),
        ListItem(Paragraph("Quando o bot clica em Sair (manual ou por regra), libera o slot.", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(Paragraph("Distribuição multi-token", H2))
    story.append(Paragraph(
        "Se houver múltiplos tokens ativos, cada token tem seu próprio contador por org. O "
        "round-robin acontece por token. Tokens não competem entre si pela mesma fila.", P))
    story.append(PageBreak())


def s9(story):
    story.append(Paragraph("9. Detecção de Partida", H1))
    story.append(hr())
    story.append(Paragraph(
        "Quando o bot da org confirma o match, um canal é criado (ou o token é adicionado a "
        "ele). O Worker captura via CHANNEL_CREATE e/ou recebendo a primeira mensagem nesse "
        "canal.", P))
    story.append(Paragraph("Padrões de nome", H2))
    story.append(code(
"Categoria: 'Partidas' ou 'SUA PARTIDA N'\n"
"Canais: \n"
"  ^fila-\\d+$        ex.: fila-958309, fila-958285\n"
"  ^partida-\\d+$     ex.: partida-0\n"
    ))
    story.append(Paragraph("Identificação do adversário", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("Lê membros do canal recém-criado e remove o próprio bot da lista.", P)),
        ListItem(Paragraph("Em fallback, parseia menção dentro da primeira mensagem do bot da org.", P)),
        ListItem(Paragraph("Mantém um buffer curto para evitar race condition (canal criado antes do membro ser adicionado).", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(callout(
        "<b>Idempotência:</b> antes de enviar a mensagem, o Worker verifica em <i>matches</i> "
        "se já existe registro com (instance_id, channel_id) e msg_sent=true."))
    story.append(PageBreak())


def s10(story):
    story.append(Paragraph("10. Mensagens dentro da Partida", H1))
    story.append(hr())
    story.append(Paragraph("Pipeline de envio:", P))
    story.append(ListFlowable([
        ListItem(Paragraph("1. Resolver template: se houver mensagem secundária para a org da partida, usa ela; senão usa a global.", P)),
        ListItem(Paragraph("2. Substituir variáveis: {adversary_mention}, {adversary_id}, {channel_name}, {org_name}, {mode}, {format}, {value}.", P)),
        ListItem(Paragraph("3. Anexar imagem (se configurada).", P)),
        ListItem(Paragraph("4. Enviar com retry leve (1 tentativa extra) em caso de 5xx; em 429 respeita o Retry-After.", P)),
        ListItem(Paragraph("5. Marcar match.msg_sent = true para idempotência.", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(Paragraph("Exemplo de payload final", H2))
    story.append(code(
"POST /channels/<channel_id>/messages\n"
"{\n"
'  "content": "Oii Mocoo, me manda uma mensagem no <@1499110161531277362>",\n'
'  "allowed_mentions": {"parse": ["users"]}\n'
"}\n"
"(+ multipart com imagem se aplicável)\n"
    ))
    story.append(PageBreak())


def s11(story):
    story.append(Paragraph("11. Telemetria, Stats & Logs", H1))
    story.append(hr())
    story.append(Paragraph("Métricas que aparecem no painel:", P))
    data = [
        ["Métrica", "Como é incrementada"],
        ["Entradas (filas entradas)", "+1 a cada clique bem-sucedido em botão de entrar."],
        ["Na Fila (filas ativas)", "Tamanho atual de queues_active da instância."],
        ["Partidas encontradas", "+1 quando um match é detectado e associado."],
        ["DMs detectadas", "+1 quando o adversário envia DM ao bot (opcional, derivado de MESSAGE_CREATE em DM)."],
        ["Uptime", "Tempo desde o último Start da instância."],
        ["@usuário", "Username do token ativo no momento."],
    ]
    t = Table(data, colWidths=[5 * cm, 12 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(Paragraph("Logs", H2))
    story.append(Paragraph(
        "Estrutura: <b>[hh:mm:ss] [LEVEL] origem · mensagem</b>. Origem pode ser: token:{username}, "
        "org:{nome}, channel:{nome}, action:{join|leave|match|send}. Manter no mínimo 100 linhas no "
        "painel e persistir em banco com rotação por dia.", P))
    story.append(PageBreak())


def s12(story):
    story.append(Paragraph("12. Rate-Limit, Erros e Resiliência", H1))
    story.append(hr())
    story.append(Paragraph(
        "O Discord retorna cabeçalhos X-RateLimit-* em quase toda chamada REST. O Worker mantém "
        "buckets por rota e por token. Em 429, respeita Retry-After e enfileira a ação.", P))
    story.append(Paragraph("Tipos de erro e tratamento", H2))
    data = [
        ["Erro", "Significado", "Ação"],
        ["401", "Token inválido", "Marcar token como INVALID, parar suas filas, alertar painel."],
        ["403", "Sem permissão / bloqueado", "Desativar org no token; logar."],
        ["429", "Rate-limit", "Aguardar Retry-After + jitter. Bucket isolado por token+rota."],
        ["5xx", "Falha temporária do Discord", "Retry exponencial limitado."],
        ["WS close 4004", "Token inválido no gateway", "Marcar INVALID."],
        ["WS close 4014", "Intents não permitidos", "Não aplicável a selfbot, mas tratar genericamente."],
    ]
    t = Table(data, colWidths=[2 * cm, 6.5 * cm, 8.5 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    story.append(callout(
        "Os logs reais já mostram <b>HTTP 429</b> ao buscar canais/tópicos. O parser deve ler "
        "Retry-After e <b>nunca</b> bloquear a thread principal — todas as ações REST passam "
        "por uma fila com leaky-bucket por token."))
    story.append(PageBreak())


def s13(story):
    story.append(Paragraph("13. Multi-Instância & Rotação de Tokens", H1))
    story.append(hr())
    story.append(Paragraph(
        "O painel mostra duas instâncias (BOT1, BOT2). Cada instância tem sua própria "
        "configuração, conjunto de tokens, contadores e logs. Instâncias rodam em isolamento.", P))
    story.append(Paragraph("Rotação automática", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("Configuração informa intervalo em minutos (ex.: 90).", P)),
        ListItem(Paragraph("Quando expira, o Worker desconecta limpo o token corrente, libera filas e abre o próximo do ciclo.", P)),
        ListItem(Paragraph("Se a textarea de tokens estiver vazia, mantém os tokens já salvos no servidor.", P)),
        ListItem(Paragraph("Painel mostra “Tokens ativos: X/Y · Próxima troca em Mm Ss”.", P)),
    ], bulletType="bullet", leftIndent=10))
    story.append(Paragraph("Comportamento ao desconectar", H2))
    story.append(Paragraph(
        "Antes de trocar de token, o Worker tenta sair das filas ativas para não deixar "
        "“fantasmas”. Se falhar (rate-limit ou indisponibilidade), registra dívida e tenta "
        "novamente quando o token reentrar no ciclo.", P))
    story.append(PageBreak())


def s14(story):
    story.append(Paragraph("14. Operação, Backups e Hardening", H1))
    story.append(hr())
    story.append(Paragraph("Itens não-funcionais essenciais antes de uso pesado:", P))
    story.append(ListFlowable([
        ListItem(Paragraph("<b>Backup de configuração</b>: export/import JSON pelo painel.", P)),
        ListItem(Paragraph("<b>Health-check</b>: endpoint /health para monitoramento externo.", P)),
        ListItem(Paragraph("<b>Auto-restart</b>: supervisor reinicia o Worker em crashes inesperados.", P)),
        ListItem(Paragraph("<b>Rotação de logs</b>: arquivar diariamente, manter últimos N dias.", P)),
        ListItem(Paragraph("<b>Segurança do painel</b>: rate-limit no login, senha forte do operador, sessão expira.", P)),
        ListItem(Paragraph("<b>Criptografia de tokens</b>: chave fora do banco; nunca logar token completo.", P)),
        ListItem(Paragraph("<b>Aviso visível</b>: rodapé já indica risco de uso (selfbot viola ToS do Discord).", P)),
    ], bulletType="bullet", leftIndent=10))

    story.append(Paragraph("Definição de Pronto (Definition of Done)", H2))
    story.append(ListFlowable([
        ListItem(Paragraph("Bot conecta tokens, descobre orgs/canais e entra em filas conforme configuração.", P)),
        ListItem(Paragraph("Atinge limite de filas por org via round-robin entre orgs e modos.", P)),
        ListItem(Paragraph("Detecta partidas em todas as variações de nome e categoria.", P)),
        ListItem(Paragraph("Envia exatamente uma mensagem por partida, com variáveis e mensagem por org.", P)),
        ListItem(Paragraph("Painel reflete em tempo real stats, logs e status; Start/Stop funcionam.", P)),
        ListItem(Paragraph("Tokens inválidos, 429 e quedas de gateway são contidos sem afetar o restante.", P)),
    ], bulletType="bullet", leftIndent=10))


def main():
    doc = SimpleDocTemplate(
        OUT, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        title="Imperiuns Bot — Deep Dive",
        author="Imperiuns",
    )

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GRAY)
        canvas.drawString(2 * cm, 1 * cm, "Imperiuns Bot — Deep Dive (Documento 2/2)")
        canvas.drawRightString(A4[0] - 2 * cm, 1 * cm, f"Página {doc.page}")
        canvas.restoreState()

    story = []
    cover(story)
    toc(story)
    s1(story); s2(story); s3(story); s4(story); s5(story); s6(story); s7(story)
    s8(story); s9(story); s10(story); s11(story); s12(story); s13(story); s14(story)

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f"OK: {OUT}")


if __name__ == "__main__":
    main()
