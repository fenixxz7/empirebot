"""Mapa mental estilo workflow do Imperiuns Bot."""
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm

OUT = "output/03_mapa_mental_imperiuns_bot.pdf"

PAGE = landscape(A3)
W, H = PAGE

NAVY = colors.HexColor("#0B1A3A")
ACCENT = colors.HexColor("#2D7CFF")
SOFT = colors.HexColor("#E8EEF9")
GREEN = colors.HexColor("#1FA86A")
RED = colors.HexColor("#E5484D")
AMBER = colors.HexColor("#F5A623")
PURPLE = colors.HexColor("#8B5CF6")
TEAL = colors.HexColor("#0EA5E9")
GRAY = colors.HexColor("#6B7280")
LIGHT = colors.HexColor("#F5F8FF")
WHITE = colors.white


def wrap(text, max_chars):
    """Quebra texto simples em linhas com até max_chars caracteres."""
    words = text.split()
    lines, cur = [], ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) <= max_chars:
            cur = (cur + " " + w).strip()
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def node(c, x, y, w, h, title, items, fill, title_color=WHITE,
         body_color=NAVY, max_chars=28):
    """Desenha um card com cabeçalho colorido e lista de itens."""
    c.setStrokeColor(colors.HexColor("#CBD5E1"))
    c.setLineWidth(0.6)
    # corpo
    c.setFillColor(WHITE)
    c.roundRect(x, y, w, h, 8, stroke=1, fill=1)
    # cabeçalho
    header_h = 0.85 * cm
    c.setFillColor(fill)
    c.roundRect(x, y + h - header_h, w, header_h, 8, stroke=0, fill=1)
    # quadrado para esconder o arredondamento inferior do header
    c.rect(x, y + h - header_h, w, 0.3 * cm, stroke=0, fill=1)
    # título
    c.setFillColor(title_color)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x + 0.4 * cm, y + h - header_h + 0.25 * cm, title)
    # itens
    c.setFillColor(body_color)
    c.setFont("Helvetica", 8.6)
    text_y = y + h - header_h - 0.45 * cm
    for it in items:
        for line in wrap("• " + it, max_chars):
            c.drawString(x + 0.4 * cm, text_y, line)
            text_y -= 0.36 * cm
    return (x, y, w, h)


def hub(c, cx, cy, r, label):
    c.setFillColor(NAVY)
    c.setStrokeColor(ACCENT)
    c.setLineWidth(2)
    c.circle(cx, cy, r, stroke=1, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(cx, cy + 0.25 * cm, "IMPERIUNS")
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(cx, cy - 0.25 * cm, label)


def line(c, x1, y1, x2, y2, color=ACCENT, width=1.2, dashed=False):
    c.setStrokeColor(color)
    c.setLineWidth(width)
    if dashed:
        c.setDash(3, 3)
    c.line(x1, y1, x2, y2)
    c.setDash()


def arrow(c, x1, y1, x2, y2, color=ACCENT, width=1.4):
    """Linha com ponta de seta simples."""
    import math
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 0.25 * cm
    ax = x2 - size * math.cos(angle - math.pi / 6)
    ay = y2 - size * math.sin(angle - math.pi / 6)
    bx = x2 - size * math.cos(angle + math.pi / 6)
    by = y2 - size * math.sin(angle + math.pi / 6)
    p = c.beginPath()
    p.moveTo(x2, y2); p.lineTo(ax, ay); p.lineTo(bx, by); p.close()
    c.drawPath(p, stroke=0, fill=1)


def header_band(c):
    c.setFillColor(NAVY)
    c.rect(0, H - 1.6 * cm, W, 1.6 * cm, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(1.2 * cm, H - 1.05 * cm, "IMPERIUNS BOT — Mapa Mental / Workflow")
    c.setFont("Helvetica", 10)
    c.setFillColor(SOFT)
    c.drawString(1.2 * cm, H - 1.4 * cm,
                 "Visão de fluxo: do operador no painel até a mensagem dentro da partida.")
    c.setFillColor(SOFT)
    c.setFont("Helvetica", 9)
    c.drawRightString(W - 1.2 * cm, H - 1.05 * cm, "Documento 3/3 · v1.0 · Abril/2026")


def legend(c):
    items = [
        ("Operador / Painel", ACCENT),
        ("Worker / Selfbot", PURPLE),
        ("Discord (eventos)", TEAL),
        ("Decisão / Lógica", AMBER),
        ("Saída / Ação", GREEN),
        ("Resiliência", RED),
    ]
    x = 1.2 * cm
    y = 1 * cm
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(NAVY)
    c.drawString(x, y + 0.55 * cm, "Legenda:")
    x += 1.7 * cm
    for label, col in items:
        c.setFillColor(col)
        c.rect(x, y + 0.45 * cm, 0.35 * cm, 0.35 * cm, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica", 9)
        c.drawString(x + 0.5 * cm, y + 0.55 * cm, label)
        x += 3.6 * cm


# ---------------- Página 1: Mapa Mental ----------------
def page_mindmap(c):
    header_band(c)

    # Hub central
    cx, cy = W / 2, H / 2 - 0.5 * cm
    r = 1.7 * cm
    hub(c, cx, cy, r, "BOT")

    # Cards (8 ramos ao redor)
    card_w = 6.6 * cm
    card_h = 5.4 * cm

    # posições (x_inferior_esquerdo, y_inferior_esquerdo)
    branches = [
        # (x, y, anchor_x, anchor_y, color, title, items)
        # Topo esquerda
        (1.5 * cm, H - 8.2 * cm, ACCENT,
         "1. Painel Web",
         ["Operador faz login",
          "Cola tokens (até 5)",
          "Escolhe categoria, orgs, modos",
          "Define mensagens e delay",
          "Aperta START / STOP"]),
        # Topo centro-esquerda
        (8.5 * cm, H - 8.2 * cm, PURPLE,
         "2. Worker conecta",
         ["Abre gateway por token",
          "READY → carrega guilds",
          "Rotação automática (min)",
          "Sessões isoladas"]),
        # Topo centro-direita
        (15.5 * cm, H - 8.2 * cm, TEAL,
         "3. Descoberta",
         ["Categorias: Mobile/Misto/Emu",
          "Canais: 1x1-mob, 2x2-mob…",
          "Cache por guild + TTL",
          "Filtra orgs habilitadas"]),
        # Topo direita
        (22.5 * cm, H - 8.2 * cm, AMBER,
         "4. Parser de Embeds",
         ["Lê card de Fila de Competição",
          "Mapeia botões: Entrar/Sair",
          "Gel Normal / Gel Inf",
          "Jogar Normal / Full UMP&XM8",
          "Adaptador por org"]),
        # Base direita
        (22.5 * cm, 2.5 * cm, AMBER,
         "5. Motor de Filas",
         ["Round-robin org × modo",
          "Maximiza filas simultâneas",
          "Respeita limite por org",
          "Sem preferir vazia/com player",
          "Delay + jitter humano"]),
        # Base centro-direita
        (15.5 * cm, 2.5 * cm, TEAL,
         "6. Detecção de Match",
         ["CHANNEL_CREATE em Partidas",
          "Regex fila-XXXX / partida-N",
          "Identifica adversário",
          "Idempotência por canal"]),
        # Base centro-esquerda
        (8.5 * cm, 2.5 * cm, GREEN,
         "7. Mensagem na Partida",
         ["Resolve template (global/org)",
          "Substitui {adversary_mention}",
          "Anexa imagem (opcional)",
          "Envia 1x · marca msg_sent"]),
        # Base esquerda
        (1.5 * cm, 2.5 * cm, RED,
         "8. Resiliência & Telemetria",
         ["429 → Retry-After + jitter",
          "401/403 → token isolado",
          "Stats e logs via WebSocket",
          "Reconexão sem perder filas"]),
    ]

    for (x, y, color, title, items) in branches:
        node(c, x, y, card_w, card_h, title, items, color)

    # Conexões do hub para o centro de cada card
    def card_anchor(x, y, side):
        if side == "top":
            return (x + card_w / 2, y)            # parte de baixo do card de cima
        if side == "bottom":
            return (x + card_w / 2, y + card_h)   # topo do card de baixo
        if side == "left":
            return (x + card_w, y + card_h / 2)
        if side == "right":
            return (x, y + card_h / 2)

    # Hub borda em direção ao card
    import math
    def hub_edge(target_x, target_y):
        ang = math.atan2(target_y - cy, target_x - cx)
        return (cx + r * math.cos(ang), cy + r * math.sin(ang))

    # Para os 4 cards do topo, a âncora é o lado de baixo do card.
    # Para os 4 de baixo, é o topo. Tudo aponta do hub para o card.
    top_indices = [0, 1, 2, 3]
    bottom_indices = [4, 5, 6, 7]
    for i in top_indices:
        x, y, color, *_ = branches[i]
        ax, ay = card_anchor(x, y, "top")
        hx, hy = hub_edge(ax, ay)
        arrow(c, hx, hy, ax, ay, color=color, width=1.4)
    for i in bottom_indices:
        x, y, color, *_ = branches[i]
        ax, ay = card_anchor(x, y, "bottom")
        hx, hy = hub_edge(ax, ay)
        arrow(c, hx, hy, ax, ay, color=color, width=1.4)

    legend(c)
    c.showPage()


# ---------------- Página 2: Workflow Sequencial ----------------
def page_workflow(c):
    header_band(c)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(1.2 * cm, H - 2.4 * cm, "Fluxo de execução — do START até o envio da mensagem")

    # Linha do tempo horizontal com etapas em duas faixas
    steps = [
        ("Operador clica START", ACCENT,
         "Painel envia comando para a API."),
        ("API publica start", ACCENT,
         "Worker carrega config da instância."),
        ("Conecta tokens (gateway)", PURPLE,
         "Identifica usuário, recebe READY."),
        ("Mapeia orgs/canais", PURPLE,
         "Filtra por categoria e modos."),
        ("Lê embeds de fila", AMBER,
         "Adaptador identifica botões."),
        ("Decide próxima fila", AMBER,
         "Round-robin org × modo, respeita limite."),
        ("Clica em ENTRAR / GEL / JOGAR", GREEN,
         "Conta +1 em Entradas; ocupa 1 slot da org."),
        ("Aguarda match", TEAL,
         "Listener CHANNEL_CREATE/MEMBER_ADD."),
        ("Detecta partida", TEAL,
         "Identifica fila-XXXX ou partida-N e adversário."),
        ("Resolve mensagem", AMBER,
         "Global ou específica por org; substitui variáveis."),
        ("Envia mensagem (+ imagem)", GREEN,
         "Marca msg_sent=true (idempotência)."),
        ("Atualiza painel", ACCENT,
         "Stats e logs via WebSocket em tempo real."),
    ]

    # Disposição em 2 linhas (6 + 6) para caber no A3 paisagem
    box_w = 6.0 * cm
    box_h = 2.6 * cm
    gap_x = 0.8 * cm
    margin_x = 1.2 * cm
    line1_y = H - 7 * cm
    line2_y = H - 12 * cm

    def draw_step(idx, x, y, label, color, desc):
        # número
        c.setFillColor(color)
        c.circle(x + 0.5 * cm, y + box_h - 0.5 * cm, 0.45 * cm, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(x + 0.5 * cm, y + box_h - 0.65 * cm, str(idx))
        # caixa
        c.setStrokeColor(colors.HexColor("#CBD5E1"))
        c.setFillColor(LIGHT)
        c.setLineWidth(0.6)
        c.roundRect(x, y, box_w, box_h, 6, stroke=1, fill=1)
        # título
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(x + 1.3 * cm, y + box_h - 0.65 * cm, label)
        # descrição
        c.setFont("Helvetica", 8.6)
        c.setFillColor(GRAY)
        ty = y + box_h - 1.2 * cm
        for line in wrap(desc, 38):
            c.drawString(x + 0.4 * cm, ty, line)
            ty -= 0.34 * cm

    # Linha 1: passos 1..6 (esquerda → direita)
    for i in range(6):
        x = margin_x + i * (box_w + gap_x)
        draw_step(i + 1, x, line1_y, *steps[i])
        if i < 5:
            x1 = x + box_w
            x2 = x + box_w + gap_x
            arrow(c, x1, line1_y + box_h / 2, x2, line1_y + box_h / 2, color=ACCENT)

    # Curva descendente entre linha 1 (passo 6) e linha 2 (passo 7)
    last_x_line1 = margin_x + 5 * (box_w + gap_x) + box_w / 2
    first_x_line2 = margin_x + 5 * (box_w + gap_x) + box_w / 2  # mesma coluna
    arrow(c, last_x_line1, line1_y, first_x_line2, line2_y + box_h, color=ACCENT)

    # Linha 2: passos 7..12 (direita → esquerda)
    for i in range(6):
        x = margin_x + (5 - i) * (box_w + gap_x)
        draw_step(i + 7, x, line2_y, *steps[i + 6])
        if i < 5:
            x1 = x
            x2 = x - gap_x
            arrow(c, x1, line2_y + box_h / 2, x2, line2_y + box_h / 2, color=ACCENT)

    # Caixa de "loop"
    loop_x = margin_x
    loop_y = 2.5 * cm
    loop_w = W - 2 * margin_x
    loop_h = 1.6 * cm
    c.setStrokeColor(AMBER)
    c.setFillColor(colors.HexColor("#FFF7ED"))
    c.setLineWidth(1.2)
    c.setDash(4, 3)
    c.roundRect(loop_x, loop_y, loop_w, loop_h, 8, stroke=1, fill=1)
    c.setDash()
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(loop_x + 0.5 * cm, loop_y + loop_h - 0.6 * cm,
                 "LOOP CONTÍNUO")
    c.setFont("Helvetica", 9.4)
    c.setFillColor(GRAY)
    c.drawString(loop_x + 0.5 * cm, loop_y + loop_h - 1.05 * cm,
                 "Após enviar a mensagem (passo 11), o motor volta ao passo 6 para escolher a próxima "
                 "fila — sempre revezando entre orgs e modos até atingir o limite de cada org.")
    c.drawString(loop_x + 0.5 * cm, loop_y + 0.25 * cm,
                 "Em paralelo, rotação de tokens, tratamento de 429 e telemetria continuam ativos durante todo o ciclo.")
    c.showPage()


def main():
    c = canvas.Canvas(OUT, pagesize=PAGE)
    c.setTitle("Imperiuns Bot — Mapa Mental / Workflow")
    page_mindmap(c)
    page_workflow(c)
    c.save()
    print(f"OK: {OUT}")


if __name__ == "__main__":
    main()
