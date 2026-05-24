# -*- coding: utf-8 -*-
"""
Build do carrossel Instagram Mizuno Wave Endeavor 3 Rosa pra Sports & Tennis.
Filosofia: Vibrant Athletic Pulse — gradient laranja-rosa, Inter Bold, branco respirando.
5 slides 1080x1350 (formato carrossel IG vertical).
"""
import os, io, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

OUT = os.path.dirname(os.path.abspath(__file__))
FONTS = r'C:\Users\sport\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\0a283f6c-1cb6-42ae-85b0-5454766dae06\4522c655-d3bb-4d60-bc39-ff4d8820050b\skills\canvas-design\canvas-fonts'

# Dimensões IG carrossel vertical
W, H = 1080, 1350

# Paleta
WHITE = (255, 255, 255, 255)
INK = (10, 10, 12, 255)
INK_SOFT = (60, 60, 65, 255)
INK_MUTE = (140, 140, 145, 255)
ORANGE = (255, 106, 31, 255)
ORANGE_DARK = (230, 69, 0, 255)
ORANGE_LIGHT = (255, 138, 77, 255)
PINK = (255, 45, 146, 255)
PURPLE = (142, 68, 236, 255)
RED = (255, 59, 48, 255)
SOFT_BG = (250, 250, 252, 255)
ORANGE_SOFT = (255, 235, 220, 255)

# Fontes
def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

# Inter não existe — uso InstrumentSans / WorkSans / BricolageGrotesque como aproximação Bold
F_HERO = lambda s: font('BricolageGrotesque-Bold.ttf', s)
F_TITLE = lambda s: font('WorkSans-Bold.ttf', s)
F_BODY = lambda s: font('InstrumentSans-Bold.ttf', s)
F_MONO = lambda s: font('GeistMono-Bold.ttf', s)
F_QUOTE = lambda s: font('Lora-BoldItalic.ttf', s)

def download_image(url, path):
    if os.path.exists(path):
        return path
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    with open(path, 'wb') as f:
        f.write(data)
    return path

# Baixa a foto do Mizuno
mizuno_path = os.path.join(OUT, '_mizuno.jpg')
print("Baixando foto Mizuno...")
download_image('https://v3b.fal.media/files/b/0a9b6e18/YpMhNdNk0cPnjrg7TUHtY_64ce192c2a0142f2a53c1bd3f7e4e0b9.jpg', mizuno_path)
mizuno = Image.open(mizuno_path).convert('RGBA')
print(f"Mizuno: {mizuno.size}")

def horizontal_gradient(w, h, c1, c2, c3=None):
    """Gradient horizontal 2 ou 3 stops."""
    img = Image.new('RGBA', (w, h), c1)
    pixels = img.load()
    for x in range(w):
        if c3:
            if x < w//2:
                t = x / (w/2)
                r = int(c1[0] + t*(c2[0]-c1[0])); g = int(c1[1] + t*(c2[1]-c1[1])); b = int(c1[2] + t*(c2[2]-c1[2]))
            else:
                t = (x-w/2) / (w/2)
                r = int(c2[0] + t*(c3[0]-c2[0])); g = int(c2[1] + t*(c3[1]-c2[1])); b = int(c2[2] + t*(c3[2]-c2[2]))
        else:
            t = x / w
            r = int(c1[0] + t*(c2[0]-c1[0])); g = int(c1[1] + t*(c2[1]-c1[1])); b = int(c1[2] + t*(c2[2]-c1[2]))
        for y in range(h):
            pixels[x, y] = (r, g, b, 255)
    return img

def diagonal_gradient(w, h, c1, c2, c3=None):
    """Gradient diagonal."""
    img = Image.new('RGBA', (w, h))
    pixels = img.load()
    max_d = w + h
    for x in range(w):
        for y in range(h):
            t = (x + y) / max_d
            if c3:
                if t < 0.5:
                    tt = t * 2
                    r = int(c1[0] + tt*(c2[0]-c1[0])); g = int(c1[1] + tt*(c2[1]-c1[1])); b = int(c1[2] + tt*(c2[2]-c1[2]))
                else:
                    tt = (t-0.5)*2
                    r = int(c2[0] + tt*(c3[0]-c2[0])); g = int(c2[1] + tt*(c3[1]-c2[1])); b = int(c2[2] + tt*(c3[2]-c2[2]))
            else:
                r = int(c1[0] + t*(c2[0]-c1[0])); g = int(c1[1] + t*(c2[1]-c1[1])); b = int(c1[2] + t*(c2[2]-c1[2]))
            pixels[x, y] = (r, g, b, 255)
    return img

def rounded_rect_mask(w, h, radius):
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, w, h], radius=radius, fill=255)
    return mask

def paste_rounded(canvas, img, x, y, radius):
    """Cola img com cantos arredondados."""
    mask = rounded_rect_mask(img.width, img.height, radius)
    canvas.paste(img, (x, y), mask)

def draw_text_centered(d, x, y, w, text, fnt, fill, line_height=None):
    """Desenha texto centralizado em x..x+w, retorna altura total."""
    lines = text.split('\n')
    if line_height is None:
        bbox = fnt.getbbox('Aj')
        line_height = int((bbox[3]-bbox[1]) * 1.18)
    total_h = 0
    for line in lines:
        bbox = d.textbbox((0,0), line, font=fnt)
        tw = bbox[2] - bbox[0]
        d.text((x + (w - tw)//2 - bbox[0], y - bbox[1]), line, font=fnt, fill=fill)
        y += line_height
        total_h += line_height
    return total_h

def footer(canvas, slide_num):
    """Rodapé com logo + slide number + brand."""
    d = ImageDraw.Draw(canvas)
    # Linha sutil
    d.line([(72, H-110), (W-72, H-110)], fill=(220, 220, 225, 255), width=1)
    # Logo T$ pequeno
    logo_size = 44
    logo_x, logo_y = 72, H-86
    logo_grad = diagonal_gradient(logo_size, logo_size, ORANGE_DARK, ORANGE, ORANGE_LIGHT)
    paste_rounded(canvas, logo_grad, logo_x, logo_y, 12)
    d.text((logo_x+10, logo_y+10), 'T$', font=F_HERO(22), fill=WHITE)
    # Brand
    d.text((logo_x+logo_size+14, logo_y+4), 'TenisCash', font=F_TITLE(18), fill=INK)
    d.text((logo_x+logo_size+14, logo_y+26), 'Sports & Tennis · João Pessoa', font=F_BODY(13), fill=INK_MUTE)
    # Slide number
    sn = f"0{slide_num} / 05"
    bbox = d.textbbox((0,0), sn, font=F_MONO(16))
    d.text((W-72-(bbox[2]-bbox[0]), logo_y+15), sn, font=F_MONO(16), fill=INK_MUTE)

# ============ SLIDE 1: HOOK ============
def slide1():
    print("Slide 1 — HOOK")
    c = Image.new('RGBA', (W, H), WHITE)
    d = ImageDraw.Draw(c)

    # Faixa gradient diagonal de fundo (sutil, na metade superior)
    grad = diagonal_gradient(W, H//2 + 150, ORANGE_DARK, ORANGE, PINK)
    mask = rounded_rect_mask(W, H//2 + 150, 0)
    c.paste(grad, (0, 0), mask)

    # Mizuno destaque grande à direita (cortado da gradient)
    m_w = 620
    m = mizuno.resize((m_w, int(mizuno.height * (m_w/mizuno.width))))
    m_x, m_y = W-m_w-30, 220
    # sombra sutil
    shadow = Image.new('RGBA', m.size, (0,0,0,0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse([60, m.height-80, m_w-60, m.height-10], fill=(0,0,0,90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    c.paste(shadow, (m_x, m_y), shadow)
    c.paste(m, (m_x, m_y), m)

    # Hashtag tag no topo
    tag_text = "#MizunoXSPTennis"
    bbox = d.textbbox((0,0), tag_text, font=F_MONO(22))
    tag_w = bbox[2]-bbox[0] + 36
    tag_x, tag_y = 72, 80
    d.rounded_rectangle([tag_x, tag_y, tag_x+tag_w, tag_y+48], radius=24, fill=(255,255,255,235))
    d.text((tag_x+18, tag_y+12), tag_text, font=F_MONO(22), fill=ORANGE_DARK)

    # Eyebrow
    d.text((72, 160), 'NOVIDADE NA LOJA', font=F_MONO(20), fill=(255,255,255,235))

    # Hook gigante (texto principal)
    d.text((72, 210), 'ACHEI', font=F_HERO(180), fill=WHITE)

    # Linha 2 do hook
    d.text((72, 410), 'o tênis que cabe', font=F_HERO(64), fill=WHITE)
    d.text((72, 484), 'na real.', font=F_HERO(64), fill=(255, 235, 220, 255))

    # Linha curta com pino
    d.rounded_rectangle([72, H-340, 72+8, H-200], radius=4, fill=ORANGE)

    d.text((100, H-340), 'Mizuno Wave Endeavor 3', font=F_TITLE(38), fill=INK)
    d.text((100, H-298), 'Edição Rosa · Feminino', font=F_BODY(22), fill=INK_SOFT)
    d.text((100, H-258), 'arrasta pra ver →', font=F_BODY(22), fill=PINK)

    footer(c, 1)
    c.convert('RGB').save(os.path.join(OUT, 'slide-1-hook.png'), 'PNG', optimize=True)

# ============ SLIDE 2: PROBLEMA ============
def slide2():
    print("Slide 2 — PROBLEMA")
    c = Image.new('RGBA', (W, H), SOFT_BG)
    d = ImageDraw.Draw(c)

    # Eyebrow
    d.text((72, 100), 'O PROBLEMA', font=F_MONO(20), fill=INK_MUTE)
    d.line([(72, 134), (240, 134)], fill=INK, width=3)

    # Pergunta grande
    d.text((72, 180), 'Cansada de tênis', font=F_HERO(74), fill=INK)
    d.text((72, 264), 'que aperta', font=F_HERO(74), fill=INK)

    # Highlight "no peito do pé" em vermelho
    text_no = 'no peito do pé?'
    d.text((72, 348), text_no, font=F_HERO(74), fill=RED)

    # Ícone grande do pé com X
    icon_y = 530
    # Círculo de fundo soft red
    d.ellipse([(W-380), icon_y, (W-80), icon_y+300], fill=(255, 226, 224, 255))
    # Pé simplificado (oval)
    foot_cx, foot_cy = W-230, icon_y+170
    d.ellipse([foot_cx-110, foot_cy-50, foot_cx+110, foot_cy+50], outline=INK, width=8)
    d.ellipse([foot_cx-115, foot_cy-110, foot_cx-35, foot_cy-50], outline=INK, width=8)  # dedão
    d.ellipse([foot_cx-50, foot_cy-95, foot_cx-15, foot_cy-60], outline=INK, width=6)
    d.ellipse([foot_cx-25, foot_cy-90, foot_cx+5, foot_cy-58], outline=INK, width=6)
    d.ellipse([foot_cx, foot_cy-87, foot_cx+25, foot_cy-58], outline=INK, width=6)
    d.ellipse([foot_cx+22, foot_cy-83, foot_cx+45, foot_cy-58], outline=INK, width=6)
    # X vermelho gigante em cima
    cx, cy, sz = foot_cx, foot_cy-20, 60
    d.line([(cx-sz, cy-sz), (cx+sz, cy+sz)], fill=RED, width=14)
    d.line([(cx+sz, cy-sz), (cx-sz, cy+sz)], fill=RED, width=14)

    # Descrição
    desc_y = icon_y + 350
    d.text((72, desc_y), 'Tênis genérico', font=F_TITLE(34), fill=INK)
    d.text((72, desc_y+50), 'não foi feito pro seu pé.', font=F_BODY(26), fill=INK_SOFT)
    d.text((72, desc_y+96), 'O Mizuno Wave Endeavor 3, foi.', font=F_BODY(26), fill=INK_SOFT)

    footer(c, 2)
    c.convert('RGB').save(os.path.join(OUT, 'slide-2-problema.png'), 'PNG', optimize=True)

# ============ SLIDE 3: SOLUÇÃO ============
def slide3():
    print("Slide 3 — SOLUÇÃO")
    c = Image.new('RGBA', (W, H), WHITE)
    d = ImageDraw.Draw(c)

    # Banda vertical gradient à esquerda
    band = diagonal_gradient(220, H, ORANGE_DARK, ORANGE, PINK)
    band_mask = Image.new('L', (220, H), 0)
    bd = ImageDraw.Draw(band_mask)
    bd.rounded_rectangle([0, 60, 220, H-60], radius=0, fill=255)
    c.paste(band, (0, 0), band_mask)
    # Texto rotado na banda
    label = Image.new('RGBA', (520, 60), (0,0,0,0))
    ld = ImageDraw.Draw(label)
    ld.text((0, 0), 'A SOLUÇÃO  ·  3 MOTIVOS  ·  MIZUNO', font=F_MONO(28), fill=WHITE)
    label = label.rotate(-90, expand=True)
    c.paste(label, (60, 380), label)

    # Eyebrow + título
    d.text((280, 100), 'POR QUE FUNCIONA', font=F_MONO(20), fill=INK_MUTE)
    d.text((280, 150), '3 razões', font=F_HERO(96), fill=INK)
    d.text((280, 270), 'pro Mizuno virar', font=F_TITLE(36), fill=INK_SOFT)
    d.text((280, 320), 'o seu favorito.', font=F_TITLE(36), fill=ORANGE_DARK)

    # Foto pequena do tênis (canto direito superior)
    sm_w = 240
    sm = mizuno.resize((sm_w, int(mizuno.height*(sm_w/mizuno.width))))
    paste_rounded(c, sm, W-sm_w-60, 120, 24)

    # 3 cards com benefícios
    benefits = [
        ('01', 'Solado X10', 'Antiderrapante até em chuva. Sola que aguenta asfalto, esteira ou areia.', ORANGE),
        ('02', 'Conforto 10km+', 'Wave Plate amortece cada passada. Você corre 10km e os pés agradecem.', PINK),
        ('03', 'Estilo casual real', 'Não é só pra correr — sai bem com legging, jeans ou shorts.', PURPLE),
    ]
    base_y = 480
    card_h = 220
    for i, (num, title, desc, color) in enumerate(benefits):
        y = base_y + i * (card_h + 20)
        # Card
        d.rounded_rectangle([260, y, W-72, y+card_h], radius=24, outline=(225,225,230,255), width=1)
        # Número grande
        d.text((290, y+30), num, font=F_HERO(72), fill=color)
        # Linha vertical
        d.rounded_rectangle([400, y+38, 404, y+card_h-38], radius=2, fill=color)
        # Texto
        d.text((430, y+38), title, font=F_TITLE(32), fill=INK)
        # Quebra automática descrição
        words = desc.split(' ')
        line = ''
        ly = y + 88
        for w in words:
            test = (line + ' ' + w).strip()
            bbox = d.textbbox((0,0), test, font=F_BODY(22))
            if bbox[2]-bbox[0] > (W-72-440):
                d.text((430, ly), line, font=F_BODY(22), fill=INK_SOFT)
                ly += 34
                line = w
            else:
                line = test
        if line:
            d.text((430, ly), line, font=F_BODY(22), fill=INK_SOFT)

    footer(c, 3)
    c.convert('RGB').save(os.path.join(OUT, 'slide-3-solucao.png'), 'PNG', optimize=True)

# ============ SLIDE 4: PROVA SOCIAL ============
def slide4():
    print("Slide 4 — PROVA SOCIAL")
    c = Image.new('RGBA', (W, H), WHITE)
    d = ImageDraw.Draw(c)

    # Fundo gradient suave (parte superior)
    grad = horizontal_gradient(W, 700, ORANGE_SOFT, (255, 240, 235, 255))
    c.paste(grad, (0, 0))

    # Eyebrow
    d.text((72, 100), 'CLIENTE REAL  ·  SPORTS & TENNIS', font=F_MONO(20), fill=ORANGE_DARK)

    # Aspas gigantes
    d.text((72, 150), '"', font=F_HERO(280), fill=ORANGE)

    # Quote
    quote_y = 320
    d.text((72, quote_y), 'Sair correndo', font=F_QUOTE(64), fill=INK)
    d.text((72, quote_y+76), 'no Cabo Branco', font=F_QUOTE(64), fill=INK)
    d.text((72, quote_y+152), 'virou prazer.', font=F_QUOTE(64), fill=ORANGE_DARK)

    # Estrelas
    stars_y = 600
    star_x = 72
    for i in range(5):
        # Estrela 5 pontas simplificada
        sx, sy = star_x + i*64, stars_y
        # desenho via polígono
        import math
        pts = []
        for j in range(10):
            angle = math.pi/2 + j * math.pi/5
            r = 24 if j % 2 == 0 else 10
            pts.append((sx + r*math.cos(angle), sy - r*math.sin(angle)))
        d.polygon(pts, fill=ORANGE)

    # Avatar circular + nome
    av_y = 720
    avatar_grad = diagonal_gradient(120, 120, ORANGE_DARK, PINK)
    avatar_mask = Image.new('L', (120, 120), 0)
    ad = ImageDraw.Draw(avatar_mask)
    ad.ellipse([0, 0, 120, 120], fill=255)
    c.paste(avatar_grad, (72, av_y), avatar_mask)
    # Inicial dentro do avatar
    d.text((105, av_y+30), 'L', font=F_HERO(60), fill=WHITE)

    d.text((220, av_y+18), 'Letícia M.', font=F_TITLE(36), fill=INK)
    d.text((220, av_y+66), 'Cliente · Sports & Tennis Bessa', font=F_BODY(22), fill=INK_MUTE)
    # Verificado
    d.ellipse([220+170, av_y+24, 220+200, av_y+54], fill=PINK)
    d.text((220+178, av_y+27), '✓', font=F_TITLE(22), fill=WHITE)

    # Linha de fechamento
    d.rounded_rectangle([72, av_y+170, W-72, av_y+172], radius=1, fill=(225,225,230,255))

    # Sub-texto
    d.text((72, av_y+200), 'Mais de 1.200 atletas correndo com', font=F_BODY(22), fill=INK_SOFT)
    d.text((72, av_y+230), 'Mizuno comprado nas nossas lojas.', font=F_TITLE(22), fill=INK)

    footer(c, 4)
    c.convert('RGB').save(os.path.join(OUT, 'slide-4-prova.png'), 'PNG', optimize=True)

# ============ SLIDE 5: CTA ============
def slide5():
    print("Slide 5 — CTA")
    c = Image.new('RGBA', (W, H), WHITE)
    d = ImageDraw.Draw(c)

    # Fundo gradient cheio
    grad = diagonal_gradient(W, H, ORANGE_DARK, ORANGE, PINK)
    c.paste(grad, (0, 0))

    # Eyebrow
    d.text((72, 90), 'BORA?', font=F_MONO(22), fill=(255,255,255,200))

    # CTA principal
    d.text((72, 140), 'Tá no estoque.', font=F_HERO(86), fill=WHITE)
    d.text((72, 240), 'É hoje.', font=F_HERO(86), fill=(255,235,220,255))

    # Box de preço glass
    box_y = 400
    box = Image.new('RGBA', (W-144, 240), (255,255,255,235))
    paste_rounded(c, box, 72, box_y, 28)
    d.text((110, box_y+30), 'PREÇO', font=F_MONO(16), fill=INK_MUTE)
    d.text((110, box_y+58), 'R$ 599', font=F_HERO(96), fill=INK)
    # Risk de "ou"
    d.text((110, box_y+180), 'ou', font=F_BODY(20), fill=INK_MUTE)
    d.text((150, box_y+170), '10x R$ 59,90', font=F_TITLE(38), fill=ORANGE_DARK)
    d.text((150, box_y+216), 'sem juros · Visa, Master, Pix', font=F_BODY(18), fill=INK_SOFT)

    # 4 lojas (cards horizontais)
    lojas = ['Bessa', 'Tambaú', 'Rainha', 'Tambiá']
    base_y = 720
    card_w = (W-144 - 30) // 4
    for i, nome in enumerate(lojas):
        x = 72 + i*(card_w+10)
        d.rounded_rectangle([x, base_y, x+card_w, base_y+120], radius=18, fill=(255,255,255,200))
        d.text((x+18, base_y+18), 'LOJA', font=F_MONO(11), fill=INK_MUTE)
        d.text((x+18, base_y+38), nome, font=F_TITLE(28), fill=INK)
        d.text((x+18, base_y+82), 'aberta hoje', font=F_BODY(15), fill=PINK)

    # CTA button gigante
    cta_y = 900
    d.rounded_rectangle([72, cta_y, W-72, cta_y+140], radius=70, fill=INK)
    d.text((W//2-100, cta_y+38), 'BORA?', font=F_HERO(64), fill=WHITE)
    d.text((W//2-200, cta_y+108), 'WhatsApp · Loja · Site teniscash.com.br', font=F_BODY(18), fill=(255,255,255,160))

    footer(c, 5)
    c.convert('RGB').save(os.path.join(OUT, 'slide-5-cta.png'), 'PNG', optimize=True)

# Roda tudo
slide1()
slide2()
slide3()
slide4()
slide5()
print("\n✓ Carrossel completo gerado em " + OUT)
print("  - slide-1-hook.png")
print("  - slide-2-problema.png")
print("  - slide-3-solucao.png")
print("  - slide-4-prova.png")
print("  - slide-5-cta.png")
