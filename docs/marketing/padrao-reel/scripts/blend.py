import json, numpy as np, soundfile as sf, os
from kokoro_onnx import Kokoro
k = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
V = k.get_voices(); print([v for v in V if v[1]=='f'])
BL = {
 "A": {"pf_dora": .70, "ef_dora": .30},
 "B": {"pf_dora": .60, "af_heart": .25, "if_sara": .15},
 "C": {"pf_dora": .55, "ff_siwis": .25, "af_bella": .20},
}
os.makedirs("blend", exist_ok=True)
txt = "Oi! Aqui é a Ispórts ênd Tênis. Não espera a Black: até cinquenta por cento em produtos selecionados. Cinco lojas te esperando em João Pessoa e Campina Grande."
for name, mix in BL.items():
    st = sum(k.get_voice_style(v) * w for v, w in mix.items())
    np.save(f"blend/voz_{name}.npy", st)
    s, sr = k.create(txt, voice=st, speed=1.05, lang="pt-br")
    sf.write(f"blend/amostra_{name}.wav", s, sr); print(name, round(len(s)/sr,2))
