# Câmeras das lojas

## Arquitetura

Cada loja usa o notebook local como ponte. As câmeras permanecem na rede
interna e publicam o vídeo no MediaMTX. O notebook:

1. recebe os streams locais sem áudio;
2. corrige as faixas horizontais causadas pela iluminação LED;
3. publica os streams corrigidos no MediaMTX;
4. grava segmentos locais de 120 segundos;
5. envia o ao vivo e as gravações para o TenisCash.

O site público e o painel nunca acessam diretamente o endereço ou a senha de
uma câmera.

## Padrão da imagem

- resolução: 1920 × 1080;
- taxa pública: 8 quadros por segundo;
- vídeo: H.264, aproximadamente 2 Mbit/s por câmera;
- áudio: desativado;
- entrada local: `lojaNN_cameraX`;
- saída corrigida: `lojaNN_cameraX_fixed`.

A correção instalada está em
`scripts/cameras/windows/band-correct.ps1`. Ela estima a iluminação de cada
linha da imagem e reduz o componente móvel produzido pelos LEDs sem misturar
quadros de pessoas em movimento.

No aplicativo Tapo, mantenha **Frequência da luz em 60 Hz** nas lojas do
Brasil. Esse ajuste atua na origem; o filtro do notebook é a segunda camada.

## Serviços automáticos no Windows

Os serviços devem ser tarefas agendadas executadas como `SYSTEM`, com gatilho
na inicialização:

- `TenisCashCameraBandCorrect`;
- `TenisCashCameraRecorder`;
- `TenisCashCameraCloudLive01` até `TenisCashCameraCloudLive06`.

O envio ao vivo é separado por câmera para impedir que uma conexão lenta
atrase todas as demais.

## Requisitos operacionais

- notebook ligado à energia;
- suspensão, hibernação e desligamento ao fechar a tampa desativados;
- Wi‑Fi da loja com acesso às câmeras e à internet;
- Tailscale em modo unattended;
- MediaMTX e FFmpeg em `C:\TenisCash\CameraAgent`.

Se o notebook ou a internet ficarem indisponíveis, o último fragmento pode
continuar visível por alguns minutos, mas não é uma transmissão atual. Quando
o notebook volta, as tarefas reiniciam automaticamente.

## Validação

Para cada câmera, confirme:

- playlist local corrigida retorna HTTP 200;
- playlist pública retorna HTTP 200;
- horário `EXT-X-PROGRAM-DATE-TIME` está próximo do horário atual;
- existe um processo de correção e um processo de gravação;
- o arquivo de gravação finalizado tem tamanho maior que zero.
