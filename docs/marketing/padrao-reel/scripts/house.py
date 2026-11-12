# Trilha HOUSE original (124 BPM, Lá menor) sintetizada em numpy + narração voz C (Chatterbox), com ducking.
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
# ===== PARÂMETROS DE CADA REEL (mudar aqui) =====
DUR = 25.2                                           # duração total do vídeo (s) = window.DUR do HTML
DROP = 1.935                                         # explosão da batida (= 1ª troca de cena, cair na batida)
BREAK = 17.42                                        # respiro de 2 tempos antes do fechamento
TRANS = [1.935, 6.29, 8.226, 9.52, 11.61, 17.42]     # trocas de cena (whoosh); de preferência múltiplos de 0.4839 s
VO = [('f0', .3), ('f1', 2.1), ('f2', 6.44), ('f3', 11.75), ('f4', 17.6), ('f5', 21.3)]  # (frase, início em s)
NARR_DIR = 'narracao'                                # saída do voz.py
# =================================================
SR = 44100; N = int(SR * DUR)
rng = np.random.default_rng(11)
BPM = 124; B = 60 / BPM; BAR = 4 * B; S16 = B / 4

def filt(x, kind, f, order=2):
    return sosfilt(butter(order, f, btype=kind, fs=SR, output='sos'), x)
def add(buf, sig, t0, g=1.0):
    i = int(round(t0 * SR)); j = min(N, i + len(sig))
    if 0 <= i < N: buf[i:j] += sig[:j - i] * g
def tt(d): return np.arange(int(d * SR)) / SR

# ---------- bateria ----------
def kick():
    t = tt(.4); f = 48 + 110 * np.exp(-t * 35)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5)
    click = filt(rng.standard_normal(len(t)), 'highpass', 3000) * np.exp(-t * 300) * .3
    return np.tanh((body + click) * 1.6)
def clap():
    t = tt(.3); n = filt(rng.standard_normal(len(t)), 'bandpass', [900, 2600]); env = np.zeros(len(t))
    for d in (0, .011, .022): k = int(d * SR); env[k:] += np.exp(-(t[:len(t) - k]) * 60) * .7
    env += np.exp(-t * 14) * .5
    return n * env
def hat(d=.035, dec=110): t = tt(d); return filt(rng.standard_normal(len(t)), 'highpass', 7500) * np.exp(-t * dec)
def ohat(): t = tt(.22); return filt(rng.standard_normal(len(t)), 'highpass', 6500) * np.exp(-t * 16)
def shaker(): t = tt(.06); return filt(rng.standard_normal(len(t)), 'bandpass', [5000, 11000]) * np.exp(-t * 60)
def boom(): t = tt(1.4); f = 32 + 70 * np.exp(-t * 7); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.8)
def riser(d):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros(len(t)); K = 12
    for k in range(K):
        sl = slice(int(k * len(t) / K), int((k + 1) * len(t) / K)); fc = 400 * (12 ** (k / K))
        out[sl] = filt(n, 'bandpass', [fc, min(fc * 2.2, 18000)])[sl]
    return out * (t / d) ** 2.4
def whoosh(d=.4): return riser(d) * .9
def crash(): t = tt(1.6); return filt(rng.standard_normal(len(t)), 'highpass', 5000) * np.exp(-t * 3.2)

# ---------- harmonia: Am7 - Fmaj7 - Dm7 - Em7 ----------
def hz(n): return 440 * 2 ** ((n - 69) / 12)
PROG = [([57, 60, 64, 67], 45), ([53, 57, 60, 64], 41), ([50, 53, 57, 60], 38), ([52, 55, 59, 62], 40)]  # (acorde midi, baixo midi)

def organ_stab(notes, d):  # stab de órgão/piano house
    t = tt(d); s = np.zeros(len(t))
    for n in notes:
        f = hz(n)
        s += np.sin(2 * np.pi * f * t) + .5 * np.sin(2 * np.pi * 2 * f * t) + .25 * np.sin(2 * np.pi * 3 * f * t) + .12 * np.sin(2 * np.pi * 4.01 * f * t)
    env = np.exp(-t * 7) * (1 - np.exp(-t * 400))
    return s / len(notes) * env
def bass_note(n, d):
    t = tt(d); f = hz(n)
    saw = 2 * ((t * f) % 1) - 1; sub = np.sin(2 * np.pi * f * t)
    env = np.exp(-t * 5) * (1 - np.exp(-t * 600))
    return filt(saw * .5, 'lowpass', 700) * env + sub * env * .9
def pad(notes, d):
    t = tt(d); s = np.zeros(len(t))
    for n in notes:
        for det in (-.12, .12): s += np.sin(2 * np.pi * hz(n + 12) * (1 + det / 100) * t)
    a = np.minimum(1, t / .4) * np.minimum(1, (d - t) / .3); return filt(s / (2 * len(notes)), 'lowpass', 2500) * a

drums = np.zeros(N); music = np.zeros(N); fx = np.zeros(N)
K, C, OH = kick(), clap(), ohat()

# intro (0 -> drop): groove filtrado + riser
for b in np.arange(0, DROP - 1e-6, B): add(drums, K, b, .5)
add(fx, riser(DROP), 0, .6)
# corpo house
b = DROP; beat = 0
while b < DUR - 2 * B:
    in_break = BREAK <= b < BREAK + 2 * B  # respiro curto no "Motivo não falta"
    if not in_break: add(drums, K, b, 1.0)
    if beat % 2 == 1: add(drums, C, b, .55)
    add(drums, OH, b + B / 2, .35)                     # hi-hat aberto no contratempo (assinatura house)
    for q in range(4):
        v = (.22, .12, .18, .12)[q]; add(drums, hat(), b + q * S16 + (S16 * .08 if q % 2 else 0), v)  # leve swing
    if beat % 4 == 3: add(drums, shaker(), b + 3 * S16, .25)
    b += B; beat += 1

# harmonia
nb = int(np.ceil(DUR / BAR)) + 1
for k in range(nb):
    t0 = DROP + (k - 1) * BAR
    chord, bn = PROG[k % 4]
    if t0 + BAR < 0: continue
    add(music, pad(chord, BAR), t0, .35)
    if t0 >= DROP - 1e-6:
        for pos in (0, .75, 1.5, 2.5, 3.0):  # ritmo de stab (tempos)
            add(music, organ_stab(chord, .28), t0 + pos * B, .55)
        for q in range(4):  # baixo no contratempo
            add(music, bass_note(bn, B * .45), t0 + q * B + B / 2, .8)

# filtro de abertura na intro (low-pass que abre até o drop)
intro_n = int(DROP * SR)
music[:intro_n] = filt(music[:intro_n], 'lowpass', 500)
drums[:intro_n] = filt(drums[:intro_n], 'lowpass', 900)

# sidechain (bombeia com o kick)
sc = np.ones(N)
for b in np.arange(DROP, DUR, B):
    if BREAK <= b < BREAK + 2 * B: continue
    i = int(b * SR); L = int(.22 * SR); j = min(N, i + L); sc[i:j] = np.minimum(sc[i:j], .25 + .75 * (np.arange(j - i) / L) ** .7)
music *= sc

# transições
for tr in TRANS:
    add(fx, whoosh(.4), tr - .4, .35)
add(fx, boom(), DROP, .8); add(fx, crash(), DROP, .35); add(fx, crash(), TRANS[len(TRANS)//2+1] if len(TRANS)>3 else DROP, .25)
add(fx, riser(2 * B), BREAK, .4); add(fx, boom(), BREAK + 2 * B, .6)

mixm = drums * .85 + music * .6 + fx * .7
fl = int(1.8 * SR); mixm[-fl:] *= np.linspace(1, 0, fl) ** 1.5

# narração (voz C, versão 2 = seeds s0)
voice = np.zeros(N)
for f, t0 in VO:
    a, sr = sf.read(f'{NARR_DIR}/{f}.wav', dtype='float64')
    if a.ndim > 1: a = a.mean(1)
    n = int(len(a) * SR / sr); a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a)
    a = filt(a, 'highpass', 90); a = a / (np.max(np.abs(a)) + 1e-9) * .85
    add(voice, a, t0)
env = filt(np.abs(voice), 'lowpass', 6); env /= env.max() + 1e-9
duck = 1 - .55 * np.clip(env * 4, 0, 1)
out = mixm / np.max(np.abs(mixm)) * .7 * duck + voice
out = np.tanh(out * 1.15); out = out / np.max(np.abs(out)) * .94
sf.write('house-voz.wav', np.stack([out, out], 1).astype(np.float32), SR)
m2 = np.tanh(mixm / np.max(np.abs(mixm)) * 1.1); sf.write('house-sem-voz.wav', np.stack([m2, m2], 1).astype(np.float32) * .94, SR)
print('ok', DUR)
