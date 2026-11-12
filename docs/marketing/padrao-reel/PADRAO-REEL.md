# PADRÃO REEL — Sports & Tennis

Aprovado pelo dono em 2026-11-12 ("perfeito, salve como padrão"). Referência: `exemplo-aprovado-antecipa-black-v3.mp4`, 25,2 s.

Todo Reel de campanha segue este padrão: **foto real + texto animado + voz C com emoção + trilha house original**, tudo gerado no PC do dono, **sem custo por vídeo** e com **licença comercial** em tudo.

---

## 1. Formato

| Item | Padrão |
|---|---|
| Tamanho | 1080×1920 (9:16), 30 fps, H.264 + AAC 192k |
| Duração | 20–30 s (o aprovado tem 25,2 s) |
| Margens livres | topo ~200 px (logo começa em y=210), base ~400 px (legenda/UI do Instagram); nada importante encostado na direita (ícones do Reel) |
| Fundo | FOTO REAL (Unsplash grátis ou foto da equipe). Nunca desenho/vetor. Sem pessoas, sem produto de terceiros, sem marca/texto de terceiros na foto (conferir com zoom) |
| Logo | Logo oficial da campanha (ex.: Antecipa Black) em todas as cenas, topo-esquerda, largura 300 px; no fechamento grande e centralizada |
| Cores | preto profundo + laranja `#F2561D` + branco |
| Tipografia | Títulos: **Barlow Condensed 900 itálico, CAIXA ALTA**; palavra-chave em laranja. Apoio: Barlow 500 itálico. Rótulo pequeno: Barlow 700, letter-spacing 9 px, laranja ("MOTIVO 01") |
| Número de destaque | Contorno laranja gigante (520 px, stroke 4 px) à direita nas cenas de motivo |

## 2. Roteiro (estrutura de venda)

Gancho → oferta → motivos → onde comprar → fechamento com o nome da loja.

| Bloco | Exemplo aprovado | Tempo |
|---|---|---|
| Gancho | "Não espera a Black!" | 0–2 s |
| Oferta (com o número contando) | "Até cinquenta por cento! Já vale, em produtos selecionados!" | 2–6 s |
| Motivos (1 cena por motivo) | "Quem chega antes, escolhe. Prova antes de levar. E o presente? Resolvido!" | 6–11,6 s |
| Onde | "São cinco lojas te esperando: Tambiá, Bessa, Tambaú, Manaíra e Campina Grande!" | 11,6–17,4 s |
| Fechamento | "Motivo não falta! A Antecipa Black já está nas lojas." + "Vem pra Isportis, i Tênis!" | 17,4–25,2 s |

**Nomes oficiais das lojas (dono 2026-11-12):** Sports & Tennis Tambiá · Sports & Tennis Praia de Manaíra · Sports & Tennis Praia de Tambaú · Sports & Tennis Praia do Bessa · Sports & Tennis Rainha da Borborema (a de Campina Grande). Instagram (convidar as 5 como colaboradoras): @sportsetennistambia · @sportsetennismanaira · @sportsetennistambau · @sportsetennisbessa · @sportsetenniscg.

**Regras de texto (inquebráveis):** a voz lê o que aparece na tela. "Até X%" só se autorizado e SEMPRE com "em produtos selecionados". Nunca inventar prazo, estoque, preço, "só hoje", "últimas unidades". Lojas exatamente como o dono definiu: Tambiá - Shopping Tambiá · Bessa — Parahyba Mall · Tambaú — Pirâmide Shopping Tambaú · Praia de Manaíra — Liv Mall · Campina Grande — Complexo K. Revisão do `safety-agent` antes de publicar.

## 3. Animação (técnicas Sanji Chien)

- Texto entra em ~0,5 s com **overshoot** (`cubic-bezier(.34,1.56,.64,1)`), vindo da esquerda (−120 a −160 px); número grande vem da direita.
- **Nada fica parado:** toda foto tem zoom lento contínuo (Ken Burns 1,0 ↔ 1,14).
- **Troca de cena = faixa laranja inclinada** varrendo de baixo pra cima + recorte (clip-path) em 0,42 s.
- Número da oferta **conta de 0 até o valor** em 1 s (ease-out).
- Lista (lojas) entra **escalonada**, sincronizada com a voz falando cada nome.
- Fechamento: logo entra grande (escala 1,35 → 1) e vai se afastando devagar; brilho laranja radial cresce ao fundo.
- **Cortes de cena caem na batida** (múltiplos de 0,4839 s a 124 BPM) e no início da frase correspondente.

## 4. Voz da marca — VOZ C (feminina, brasileira, sintética e exclusiva)

- **Não é clone de ninguém** (dono escolheu voz sintética exclusiva). Timbre = mistura Kokoro: 55% `pf_dora` (pt-BR) + 25% `ff_siwis` + 20% `af_bella` → `voz/voz_C.npy`. Áudio de referência do timbre: `voz/voz-C-referencia.wav` (**NÃO apagar — é a identidade da voz**).
- **Emoção** (dono: "vendas é emoção"): gerar com **Chatterbox Multilingual** (Resemble AI, licença MIT, uso comercial OK) usando a referência acima, com `exaggeration=0.8`, `cfg_weight=0.35`, `temperature=0.8`, `language_id="pt"`, seed 0 (= "versão 2" aprovada).
- **Escrita que dá emoção:** frases curtas, exclamação no fim, pergunta + resposta ("E o presente? Resolvido!"), dois-pontos antes de lista.
- **Nome da loja:** se fala "isportis i tênis". **Escrever sempre `Isportis, i Tênis` (com vírgula).** Sem vírgula vira "das Portes"; escrito em inglês vira "Esportes Dênis". Evitar "da/nas" colado antes do nome → usar "Vem pra Isportis, i Tênis!".
- **Números por extenso** na fala ("cinquenta por cento"), na tela em algarismo ("50%").
- ❌ **Não usar VoiceStudio** (modelo padrão OmniVoice é NÃO-comercial; nenhum modelo do catálogo liberado pra uso comercial). ❌ Não clonar voz de pessoa real sem autorização por escrito.

## 5. Trilha — HOUSE original

Composta em código (`scripts/house.py`): **não é música de ninguém** → sem direito autoral, sem risco de o Instagram silenciar.

- 124 BPM, Lá menor, progressão **Am7 – Fmaj7 – Dm7 – Em7** (1 compasso cada).
- Bumbo nos 4 tempos (four-on-the-floor), palma no 2 e 4, **hi-hat aberto no contratempo**, hi-hat fechado em 16 com leve swing, shaker.
- Baixo no contratempo, stabs de órgão house, pad de fundo.
- **Sidechain** (a música "respira" a cada bumbo) — é o que dá a pulsação.
- Estrutura: intro abafada (filtro) + riser → **explode no DROP** (a oferta) → groove → respiro de 2 tempos antes do fechamento → volta → fade final 1,8 s.
- Efeitos: whoosh em toda troca de cena, boom + prato no drop.
- **Ducking:** a música abaixa ~55% quando a voz fala (a voz sempre na frente).

## 6. Como produzir (passo a passo)

Pré-requisitos no PC (Windows, RTX 4050):
1. **Vídeo:** Node + `npm i` em `scripts/` (puppeteer-core 23 + ffmpeg-static 5). Usa o Chrome instalado.
2. **Voz:** venv Python 3.11 com `chatterbox-tts` + torch CUDA (`uv pip install chatterbox-tts --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match`) **e `setuptools<81`** (senão o watermarker Perth quebra com `pkg_resources`). ~4,5 GB de download. Python 3.15 não tem as bibliotecas — usar `uv` pra criar o venv 3.11.
3. **Conferência:** venv com `faster-whisper` (modelo "small"), pra transcrever de volta.

Passos:
1. **Roteiro** → `frases.json` (`[{"id":"f0","texto":"..."}]`), seguindo a seção 2 e 4.
2. **Voz:** `python scripts/voz.py frases.json 0` → `narracao/f0.wav…`. Medir a duração de cada frase.
3. **Conferir a fala:** `python scripts/wcheck.py "narracao/*.wav"` → o texto transcrito tem que bater (o nome da loja aparece como "esportes e tênis"/"Sportis e Tennis" = certo).
4. **Timeline:** copiar `scripts/reel-modelo.html` para `reel.html` na pasta de trabalho (o `render.js` lê `reel.html`), trocar `PH` (pasta das fotos) e `LOGO`, os textos e então encaixar cada cena no início da sua frase, arredondando pra batida (0,4839 s). Atualizar os tempos em `scripts/reel-modelo.html` (cenas, `MT`, `window.DUR`, contador) e em `scripts/house.py` (`DUR`, `DROP`, `BREAK`, `TRANS`, `VO`).
5. **Fotos:** escolher 1 foto por cena, conferir com zoom (sem pessoa/marca/texto de terceiros).
6. **Prévia:** `node render.js x "0.3,2.5,7,..."` → `prev/` → olhar os quadros.
7. **Vídeo:** `node render.js video.mp4`.
8. **Trilha + voz:** `python scripts/house.py` → `house-voz.wav` (e `house-sem-voz.wav`).
9. **Juntar:** `ffmpeg -i video.mp4 -i house-voz.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart reel.mp4`.
10. **Conferir o final:** quadros-chave + Whisper no áudio final (voz entendível por cima da música) + volume estável por trecho.
11. **safety-agent** → só então publicar (com ordem do dono).

## 7. Publicação

**REGRA (dono 2026-11-12): toda publicação convida as 5 lojas como colaboradoras e os 5 convites têm que ser ACEITOS.** No navegador o Instagram não mostra o botão "Aceitar" → aceitar no app do celular, em cada conta de loja (Notificações → convite → Aceitar), ou via Graph API `collaboration_invites` com o token de cada loja.

Publicação pelo navegador (Chrome logado em @sportsetennis): Criar → Postar → subir o MP4 → Cortar "Original" → capa = quadro com o título (subir JPG) → legenda → Adicionar colaboradores (as 5) → **Adicionar rótulo de IA = ligado** (voz sintética) → Compartilhar. Pela API o limite é 3 colaboradores; pelo navegador cabem as 5.

- Instagram @sportsetennis via Graph API: IG Business ID `17841472762351439` + `META_PAGE_TOKEN` (ver memória `instagram-publicacao-api`). Ou o dono posta pelo app.
- Legenda segue as mesmas regras (até X% + produtos selecionados, lojas exatas, sem prazo/estoque).

## 8. Arquivos deste padrão

| Arquivo | O que é |
|---|---|
| `voz/voz-C-referencia.wav` | Timbre da voz C (referência do Chatterbox) — identidade da marca |
| `voz/voz_C.npy` | Vetor da voz C no Kokoro (versão sem emoção) |
| `scripts/voz.py` | Gera as falas com a voz C e emoção |
| `scripts/house.py` | Trilha house + efeitos + mix com a voz |
| `scripts/reel-modelo.html` | Modelo do vídeo (cenas, animações) — Antecipa Black como exemplo |
| `scripts/render.js` + `package.json` | Renderiza o HTML quadro a quadro em MP4 |
| `scripts/wcheck.py` | Conferência da fala por transcrição |
| `scripts/blend.py` | Como a voz C foi criada (mistura Kokoro) |
| `exemplo-aprovado-antecipa-black-v3.mp4` | O Reel aprovado (referência de qualidade) |

Validado em 2026-11-12: os scripts deste padrão reproduzem o Reel aprovado (voz idêntica; trilha com diferença máx. 0,0002).
