# VOZ DA MARCA (voz C) — gera cada frase com emoção de vendedora.
# Uso:  cb311\Scripts\python voz.py frases.json [seed]
#   frases.json = [{"id": "f0", "texto": "Não espera a Black!"}, ...]
#   saída: narracao/<id>.wav  (24 kHz)
# Regras de texto: exclamação/pergunta dão a emoção; nome da loja SEMPRE "Isportis, i Tênis" (com vírgula).
import os, sys, json, torch, torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

AQUI = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(AQUI, "..", "voz", "voz-C-referencia.wav")   # timbre da voz C (sintética, exclusiva)
EXAGGERATION, CFG, TEMP = 0.8, 0.35, 0.8                         # valores APROVADOS pelo dono (2026-11-12)

frases = json.load(open(sys.argv[1], encoding="utf8"))
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 0               # seed 0 = "versão 2" aprovada
m = ChatterboxMultilingualTTS.from_pretrained(device="cuda" if torch.cuda.is_available() else "cpu")
os.makedirs("narracao", exist_ok=True)
for i, f in enumerate(frases):
    torch.manual_seed(seed * 10 + i)
    w = m.generate(f["texto"], language_id="pt", audio_prompt_path=REF,
                   exaggeration=EXAGGERATION, cfg_weight=CFG, temperature=TEMP)
    ta.save(f"narracao/{f['id']}.wav", w, m.sr)
    print("ok", f["id"], round(w.shape[1] / m.sr, 2), "s", flush=True)
