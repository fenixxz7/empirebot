"""Gera o PDF de Roadmap (visão geral) do projeto Imperiuns Bot."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    ListFlowable, ListItem,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

OUT = "output/01_roadmap_imperiuns_bot.pdf"

NAVY = colors.HexColor("#0B1A3A")
ACCENT = colors.HexColor("#2D7CFF")
SOFT = colors.HexColor("#E8EEF9")
GREEN = colors.HexColor("#1FA86A")
GRAY = colors.HexColor("#6B7280")

styles = getSampleStyleSheet()

H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontName="Helvetica-Bold",
                   fontSize=22, leading=26, textColor=NAVY, spaceAfter=10)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontName="Helvetica-Bold",
                   fontSize=15, leading=19, textColor=ACCENT, spaceBefore=14, spaceAfter=6)
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontName="Helvetica-Bold",
                   fontSize=12, leading=16, textColor=NAVY, spaceBefore=8, spaceAfter=4)
P  = ParagraphStyle("P", parent=styles["BodyText"], fontName="Helvetica",
                   fontSize=10.5, leading=15, alignment=TA_JUSTIFY, spaceAfter=6)
PB = ParagraphStyle("PB", parent=P, fontName="Helvetica-Bold")
SUB = ParagraphStyle("SUB", parent=P, fontSize=9.5, textColor=GRAY)
TAG = ParagraphStyle("TAG", parent=P, fontSize=9, textColor=colors.white)


def hr():
    t = Table([[""]], colWidths=[17 * cm], rowHeights=[0.04 * cm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)]))
    return t


def phase_card(num, title, goal, deliverables, depends):
    header = Table(
        [[Paragraph(f"<b>FASE {num}</b>", TAG), Paragraph(f"<b>{title}</b>", H3)]],
        colWidths=[2.4 * cm, 14.6 * cm],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), ACCENT),
        ("BACKGROUND", (1, 0), (1, 0), SOFT),
        ("ALIGN", (0, 0), (0, 0), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    body_data = [
        [Paragraph("<b>Objetivo</b>", PB), Paragraph(goal, P)],
        [Paragraph("<b>Entregáveis</b>", PB),
         ListFlowable([ListItem(Paragraph(d, P)) for d in deliverables],
                      bulletType="bullet", leftIndent=10)],
        [Paragraph("<b>Depende de</b>", PB),
         Paragraph(depends if depends else "—", P)],
    ]
    body = Table(body_data, colWidths=[3.4 * cm, 13.6 * cm])
    body.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F5F8FF")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return [header, body, Spacer(1, 0.35 * cm)]


def cover(story):
    story.append(Spacer(1, 4 * cm))
    story.append(Paragraph("IMPERIUNS BOT", ParagraphStyle(
        "cov", parent=H1, fontSize=34, leading=40, alignment=TA_CENTER, textColor=NAVY)))
    story.append(Paragraph("Painel de Controle &amp; Selfbot de Filas Free Fire (Discord)",
                           ParagraphStyle("covsub", parent=H2, alignment=TA_CENTER,
                                          textColor=ACCENT, fontSize=14)))
    story.append(Spacer(1, 1 * cm))
    story.append(Paragraph("Documento 1 de 2 — <b>Roadmap Geral</b>",
                           ParagraphStyle("covt", parent=P, alignment=TA_CENTER,
                                          fontSize=12)))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph("Versão 1.0 · Abril/2026",
                           ParagraphStyle("covd", parent=SUB, alignment=TA_CENTER)))
    story.append(Spacer(1, 4 * cm))
    box = Table(
        [[Paragraph(
            "Este roadmap descreve, em alto nível, todas as fases necessárias para reconstruir o "
            "bot do zero — desde a infraestrutura e o painel web até o motor de filas, detecção de "
            "partidas, envio de mensagens e operação contínua. O segundo documento aprofunda cada "
            "tópico apresentado aqui.", P)]],
        colWidths=[15 * cm])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(box)
    story.append(PageBreak())


def overview(story):
    story.append(Paragraph("Visão Geral", H1))
    story.append(hr())
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "O Imperiuns Bot é um sistema dividido em duas grandes peças: um <b>painel web</b> que o "
        "operador usa para configurar tokens, modos, orgs, mensagens, delays e estatísticas; e um "
        "<b>worker (selfbot)</b> que se conecta ao Discord via gateway com um ou mais tokens, "
        "entra automaticamente nas filas dos servidores parceiros, detecta quando uma partida é "
        "criada e envia mensagens/imagens dentro do canal recém-aberto.", P))
    story.append(Paragraph(
        "O comportamento desejado, diferente de simplesmente preferir filas com ou sem players, é "
        "<b>revezar entre todos os modos e todas as orgs</b> até atingir o limite individual de "
        "filas que cada org permite por usuário. Em outras palavras: o bot precisa pulverizar a "
        "presença, garantindo que sempre haja o máximo possível de filas ativas simultâneas, sem "
        "concentrar em um único modo ou em uma única org.", P))

    story.append(Paragraph("Arquitetura em camadas", H2))
    data = [
        ["Camada", "Responsabilidade"],
        ["Painel Web (Frontend)", "UI de configuração, dashboard de stats, logs ao vivo, controle Start/Stop."],
        ["API/Backend", "Persistência de configuração, autenticação, broadcast de stats e logs (WebSocket)."],
        ["Worker (Selfbot Engine)", "Gateway Discord, descoberta de canais, entrada em filas, detecção de match, envio de mensagens."],
        ["Camada de Dados", "Tokens, configurações, métricas, log histórico, estado por instância (BOT1/BOT2)."],
    ]
    t = Table(data, colWidths=[5 * cm, 12 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    story.append(PageBreak())


def phases(story):
    story.append(Paragraph("Fases do Projeto", H1))
    story.append(hr())
    story.append(Spacer(1, 0.3 * cm))

    fases = [
        (1, "Discovery & Especificação",
         "Consolidar todas as regras de negócio: orgs, modos, formatos de embed, tipos de botão, padrões de canal de partida, limites por org, prioridades de mensagem.",
         ["Mapa de orgs (nome, guild_id, categorias, canais por modo)",
          "Catálogo de variantes de embed e botões (Entrar/Sair, Gel Normal/Inf, Jogar Normal/Full UMP & XM8, etc.)",
          "Glossário de regex/heurísticas para nomes de canal de match (fila-XXXX, partida-X)",
          "Lista de modos e formatos suportados (1x1, 2x2, 3x3, 4x4, e variações x1/x2/x3/x4)"],
         "—"),
        (2, "Infraestrutura & Banco de Dados",
         "Subir base do projeto, banco relacional, fila/cache, schema de configuração, métricas e logs.",
         ["Schema: users, instances, tokens, orgs, channels, queues, matches, messages, stats, logs",
          "Migrations e seeders iniciais (orgs e modos conhecidos)",
          "Camada de criptografia para tokens em repouso",
          "Estrutura de diretórios e padrões de código"],
         "Fase 1"),
        (3, "Backend / API & Auth",
         "Construir a API que serve o painel: autenticação, CRUD de configuração, broadcast em tempo real.",
         ["Login do operador (sessão segura)",
          "Endpoints REST de configuração (tokens, orgs, modos, mensagens, delay, rotação)",
          "WebSocket para stats e logs em tempo real",
          "Endpoints de controle: start/stop por instância, reset de stats"],
         "Fase 2"),
        (4, "Painel Web (Frontend)",
         "Reproduzir o painel mostrado nas referências: status, instâncias BOT1/BOT2, controles, stats, configuração e logs.",
         ["Tela de Controle com botão Start/Stop e seletor de instância",
          "Cards de estatísticas (Entradas, Na Fila, Partidas, DMs, Uptime)",
          "Formulário de Configuração (tokens, rotação, categoria, orgs, delay, modos, mensagens)",
          "Console de Logs ao vivo com níveis e filtro",
          "Tema escuro com identidade Imperiuns"],
         "Fase 3"),
        (5, "Worker — Núcleo do Selfbot",
         "Conectar tokens ao gateway do Discord, manter sessões resilientes e expor API interna para os módulos superiores.",
         ["Gerenciador de sessões multi-token com reconexão e backoff",
          "Rotação automática de tokens a cada N minutos",
          "Listener de eventos relevantes (READY, GUILD_CREATE, MESSAGE_CREATE, CHANNEL_CREATE, GUILD_MEMBER_ADD)",
          "Camada anti-rate-limit (bucket por rota, jitter, fila de envio)"],
         "Fase 2"),
        (6, "Descoberta de Orgs, Categorias e Canais",
         "Mapear dinamicamente em quais guilds o token está e quais canais correspondem aos modos configurados.",
         ["Filtro por categoria (Mobile, Misto, Emulador) e por nomes de canal (1x1-mob, 2x2-mob, etc.)",
          "Cache por guild com TTL e invalidação em eventos de canal",
          "Whitelist/blacklist de orgs no painel",
          "Resolução de prioridade por org (nome ou guild_id)"],
         "Fase 5"),
        (7, "Parser de Embeds & Botões",
         "Interpretar os cards de fila de cada org, mesmo com visual diferente, e mapear para uma estrutura comum.",
         ["Adaptadores por org/template (Moreira, Colombia, Gold, Bounty, etc.)",
          "Modelo unificado: {modo, formato, valor, jogadores, variantes_de_botao}",
          "Reconhecimento de botões (Entrar, Sair, Gel Normal, Gel Inf, Jogar Normal, Jogar Full UMP & XM8)",
          "Resiliência a edição de mensagens e atualização de embeds"],
         "Fase 6"),
        (8, "Motor de Filas (Round-Robin Org × Modo)",
         "Decidir, em ciclo, em qual fila o bot entra a seguir, respeitando limites e modos permitidos.",
         ["Algoritmo round-robin justo entre orgs e modos",
          "Controle do limite máximo de filas simultâneas por org/usuário",
          "Suporte a entrar tanto em filas com player quanto vazias, sem preferência",
          "Delay configurável entre cliques e jitter humano"],
         "Fase 7"),
        (9, "Detecção de Partida (Match)",
         "Identificar com segurança quando um canal de partida foi criado para o bot.",
         ["Listener de CHANNEL_CREATE / MEMBER_ADD em categorias de partida",
          "Regex/heurística para nomes (fila-XXXXXX, partida-N, SUA PARTIDA N)",
          "Associação match ↔ fila de origem ↔ adversário (mention/ID)",
          "Deduplicação para evitar processar a mesma partida duas vezes"],
         "Fase 8"),
        (10, "Mensagens dentro da Partida",
         "Enviar a mensagem/imagem certa, com as variáveis substituídas e respeitando regras por org.",
         ["Substituição de variáveis: {adversary_mention}, {adversary_id}, {channel_name}",
          "Mensagem principal global + mensagem secundária por org (prioridade por nome ou guild_id)",
          "Suporte a imagem anexa configurada no painel",
          "Controle de envio único por partida com idempotência"],
         "Fase 9"),
        (11, "Telemetria, Stats & Logs",
         "Atualizar painel em tempo real com contadores e logs estruturados.",
         ["Contadores: Entradas em fila, Filas ativas, Partidas, DMs, Uptime",
          "Reset de stats por instância",
          "Log estruturado por nível (INFO/WARN/ERROR) com origem (org, canal, ação)",
          "Persistência de log com rotação"],
         "Fase 4 + 5"),
        (12, "Hardening, Observabilidade & Operação",
         "Tornar o sistema robusto para uso contínuo e múltiplas instâncias.",
         ["Tratamento de 401/403 (token inválido) e 429 (rate-limit) com isolamento por token",
          "Health-checks e auto-restart de sessão",
          "Backups de configuração e exportação/importação",
          "Documentação de operação e troubleshooting"],
         "Todas as anteriores"),
    ]
    for f in fases:
        for el in phase_card(*f):
            story.append(el)

    story.append(PageBreak())


def timeline(story):
    story.append(Paragraph("Linha do Tempo Sugerida", H1))
    story.append(hr())
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "A linha do tempo abaixo é uma sugestão de ordem prática de execução, agrupando "
        "fases que podem caminhar em paralelo. Não representa prazos fechados — são blocos "
        "lógicos de trabalho.", P))
    data = [
        ["Bloco", "Fases", "Descrição"],
        ["Bloco A — Fundação", "1, 2", "Especificação completa, banco e infraestrutura mínima."],
        ["Bloco B — Painel", "3, 4", "Backend de configuração e frontend do painel utilizável."],
        ["Bloco C — Núcleo", "5, 6, 7", "Selfbot conectando, descobrindo canais e lendo embeds."],
        ["Bloco D — Operação", "8, 9, 10", "Entrar em filas, detectar partidas, enviar mensagens."],
        ["Bloco E — Produção", "11, 12", "Telemetria refinada e endurecimento para uso real."],
    ]
    t = Table(data, colWidths=[3.6 * cm, 2.6 * cm, 10.8 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)

    story.append(Paragraph("Critérios de “pronto”", H2))
    bullets = [
        "Operador consegue logar no painel, colar tokens, escolher orgs/modos/mensagens e salvar.",
        "Ao apertar Start, o bot conecta todos os tokens e aparece como “Conectado / Rodando”.",
        "O bot revezando entre orgs e modos atinge o limite de filas simultâneas de cada org.",
        "Cada partida criada gera uma única mensagem dentro do canal, com as variáveis corretas.",
        "Stats e logs do painel batem com o comportamento real observado no Discord.",
        "Tokens inválidos, 429 e desconexões não derrubam o sistema — apenas o token afetado.",
    ]
    story.append(ListFlowable(
        [ListItem(Paragraph(b, P)) for b in bullets], bulletType="bullet", leftIndent=10))


def riscos(story):
    story.append(PageBreak())
    story.append(Paragraph("Riscos & Pontos de Atenção", H1))
    story.append(hr())
    story.append(Spacer(1, 0.3 * cm))
    items = [
        ("Termos de Serviço do Discord",
         "Selfbots violam o ToS do Discord. O operador assume o risco de banimento de conta. "
         "O painel deve manter o aviso já existente: “Use por sua conta e risco.”"),
        ("Diferenças de embed por org",
         "Cada org pode mudar visual, ordem dos botões e nomes (Entrar/Sair, Gel Normal/Inf, "
         "Jogar Normal/Full UMP & XM8). É necessário um sistema de adaptadores extensível."),
        ("Rate-limit e 429",
         "Erros 429 já aparecem nos logs reais. O motor precisa isolar a punição por token e "
         "por rota, com backoff exponencial e jitter."),
        ("Limite por org",
         "Cada org permite apenas N filas simultâneas. O algoritmo de round-robin precisa "
         "respeitar esse teto e liberar slots quando uma fila vira partida ou é cancelada."),
        ("Idempotência de mensagens",
         "Sob reconexão ou eventos duplicados, é fácil mandar a mesma mensagem duas vezes na "
         "mesma partida. Precisa de chave única por (token, channel_id)."),
        ("Rotação de tokens",
         "A troca de tokens em ciclo precisa preservar o estado de filas ativas — ou desconectar "
         "limpo antes de trocar para evitar “fantasma” em uma org."),
    ]
    for titulo, desc in items:
        story.append(Paragraph(f"<b>{titulo}</b>", H3))
        story.append(Paragraph(desc, P))


def main():
    doc = SimpleDocTemplate(
        OUT, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        title="Imperiuns Bot — Roadmap",
        author="Imperiuns",
    )

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GRAY)
        canvas.drawString(2 * cm, 1 * cm, "Imperiuns Bot — Roadmap (Documento 1/2)")
        canvas.drawRightString(A4[0] - 2 * cm, 1 * cm, f"Página {doc.page}")
        canvas.restoreState()

    story = []
    cover(story)
    overview(story)
    phases(story)
    timeline(story)
    riscos(story)

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f"OK: {OUT}")


if __name__ == "__main__":
    main()
