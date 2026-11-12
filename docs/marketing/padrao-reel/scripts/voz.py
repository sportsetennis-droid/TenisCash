# VOZ DA MARCA (voz C) — gera cada frase com emoção de vendedora.
# Uso:  cb311\Scripts\python voz.py frases.json [seed]
#   frases.json = [{"id": "f0", "texto": "Não espera a Black!"}, ...]
#   saída: narracao/<id>.wav  (24 kHz)
# Regras de texto: exclamação/pergunta dão a emoção.
# ⛔ NOME DA LOJA (OBRIGATÓRIO, dono 2026-11-12): a frase "Vem pra Isportis, i Tênis!" NUNCA é gerada de novo.
#    Ela é SEMPRE a cópia do áudio aprovado voz/assinatura-isportis-i-tenis-APROVADA.wav.
#    Motivo: o Chatterbox sorteia a pronúncia (a semente aqui = seed*10 + posição da frase); no Reel Body for Sure
#    a frase ficou na posição 7 (semente 7 ≠ semente 5 da aprovada) e o nome da loja saiu errado.
import os, sys, json, shutil, torch, torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

AQUI = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(AQUI, "..", "voz", "voz-C-referencia.wav")   # timbre da voz C (sintética, exclusiva)
ASSINATURA = os.path.join(AQUI, "..", "voz", "assinatura-isportis-i-tenis-APROVADA.wav")
EXAGGERATION, CFG, TEMP = 0.8, 0.35, 0.8                         # valores APROVADOS pelo dono (2026-11-12)

def eh_assinatura(texto):
    t = texto.lower().replace(" ", "")
    return "isportis" in t or "sports&tennis" in t or "esportes" in t and "tênis" in t

frases = json.load(open(sys.argv[1], encoding="utf8"))
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 0               # seed 0 = "versão 2" aprovada
os.makedirs("narracao", exist_ok=True)
m = None
for i, f in enumerate(frases):
    if eh_assinatura(f["texto"]):
        shutil.copyfile(ASSINATURA, f"narracao/{f['id']}.wav")
        print("ok", f["id"], "= ASSINATURA APROVADA (copiada, não gerada)", flush=True)
        continue
    if m is None:
        m = ChatterboxMultilingualTTS.from_pretrained(device="cuda" if torch.cuda.is_available() else "cpu")
    torch.manual_seed(seed * 10 + i)
    w = m.generate(f["texto"], language_id="pt", audio_prompt_path=REF,
                   exaggeration=EXAGGERATION, cfg_weight=CFG, temperature=TEMP)
    ta.save(f"narracao/{f['id']}.wav", w, m.sr)
    print("ok", f["id"], round(w.shape[1] / m.sr, 2), "s", flush=True)
