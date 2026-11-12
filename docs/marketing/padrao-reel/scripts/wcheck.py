# Transcreve WAVs (glob) com Whisper small, sem dica, pra conferir o que a voz falou.
import sys, glob, numpy as np, soundfile as sf
from faster_whisper import WhisperModel
m = WhisperModel("small", device="cpu", compute_type="int8")
for f in sorted(glob.glob(sys.argv[1])):
    a, sr = sf.read(f, dtype="float32")
    if a.ndim > 1: a = a.mean(1)
    n = int(len(a) * 16000 / sr); a16 = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    segs, _ = m.transcribe(a16, language="pt", beam_size=5)
    print(f, f"{len(a)/sr:.2f}s", "=>", " ".join(s.text.strip() for s in segs), flush=True)
