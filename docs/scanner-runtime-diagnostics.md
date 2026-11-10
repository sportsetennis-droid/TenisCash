# Diagnóstico interno de recursos do leitor

Preparado em 10/11/2026 sobre `53e01135`. Implementação e testes locais não comprovam coleta nem publicação em Linux.

O limite do processo de imagem permanece em 384 MiB de RSS, 128 MiB de heap, 24 segundos para etiqueta e 8 segundos para código. Esses são limites da aplicação; não são a memória e a CPU contratadas no Railway.

Quando o broker interrompe uma chamada por `SCANNER_IMAGE_MEMORY_LIMIT` ou `SCANNER_IMAGE_TIMEOUT`, preserva a razão original e associa um pequeno diagnóstico ao mesmo job. A fila registra a versão saneada exclusivamente no `output.scannerDiagnostic` do job concluído como pendente. O reagendamento continua vinculado à mesma captura/revisão. Não há campo novo nas respostas de histórico, scanner ou health, no cadastro, na foto, no bipe ou na evidência de identidade. Uma falha de processo continua `SCANNER_IMAGE_UNAVAILABLE`; não é reclassificada como falta de memória por suposição.

Campos permitidos:

- `source`: `scanner-runtime-diagnostic-v1`;
- fase fechada: starting, decode, ocr-init, metadata, enhance, stretch, raster-metadata, ocr, done;
- operação label/barcode, sistema linux/win32/darwin, arquitetura x64/arm64 e versões numéricas de Node, Sharp, libvips e Tesseract;
- RSS da amostra e maior RSS observado **neste job**, limite de RSS, tempo total no broker, prazo da operação e instante da amostra no worker;
- largura, altura e pixels efetivos do raster antes de `recognize`, número da tentativa, rotação, PSM e indicador de realce;
- valor numérico limitado de `MALLOC_ARENA_MAX`, quando presente, e somente um booleano informando a presença de `LD_PRELOAD`.

`peakRssObservedBytes` é o máximo das amostras recebidas, não o pico exato do kernel. O relógio de `elapsedMs` começa quando o broker inicia o job (inclui a inicialização do processo); `phaseElapsedMs` marca a amostra desde o início da chamada dentro do worker. Dimensões são omitidas até serem medidas; não são inferidas. `LD_PRELOAD` nunca tem o conteúdo gravado. Não são armazenados imagem, OCR, código, nome, caminho, token ou ambiente completo. Campos desconhecidos, versões fora do formato e números inválidos/fora dos limites são descartados novamente antes da persistência.

O relatório de cada chamada fecha sobre seu próprio ID de IPC. O broker rejeita eventos com outro ID e eventos de processo substituído ou em encerramento. O estado de diagnóstico não é reaproveitado quando um processo de barcode atende outra peça. Uma recuperação de foto sem bipe entrega métricas apenas por callback interno da fila, mantendo sua resposta normal sem esse campo. A leitura de código e a validação de produto/tamanho mantêm suas regras originais. Falha do callback de diagnóstico não altera o reconhecimento.

A coleta de dimensões lê metadados dos mesmos buffers que já seriam enviados ao OCR, sem redimensionar, recortar, normalizar ou alterar os pixels. Nenhuma decisão de identidade usa métricas. A frequência de fiscalização de RSS continua a mesma: amostras a cada 250 ms e ao terminar a operação; eventos de fase só registram medições, sem criar novos critérios de interrupção.

## Verificações

- `test:scanner`: suíte completa passou com Node 22.23.4 no Windows.
- `test-scanner-runtime-diagnostics.cjs`: allowlist/limites; versões; ausência de dados sensíveis; motivo original de erro; evento atrasado; processo substituído; reutilização de barcode; snapshot do callback real do worker; buffers de OCR byte a byte; falha de observador ignorada.
- `test-stock-replacement-queue.cjs`: PostgreSQL local isolado; output do job contém apenas métricas saneadas, sem repassá-las a evidência/health/request, e não movimenta saldo por falha de recursos.
- `test-stock-replacement-capture-recovery.cjs`: erro de código por memória/tempo mantém foto/razão, zero novos bipes/movimentos e callback interno saneado.

A instrumentação não corrige por si só o estouro de recursos. Ela permite examinar a fase e as dimensões reais antes de escolher uma correção com evidência de Linux. As medições locais de Windows não comprovam o pico de produção.
