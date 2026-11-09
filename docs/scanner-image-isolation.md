# Isolamento do processamento de etiquetas

Implementação local de 09/11/2026. Publicação e ensaio físico não são comprovados por este documento.

## Contrato mantido

`scannerArchivedLabel.readImage(Buffer, barcode)` mantém a evidência extraída da própria foto ou retorna `pending/retry/reason`. `readWords`, `target` e `fiscalRows` preservam os vínculos fiscais, geometria de BR, referência/cor, barcode e evidência de revisão existentes. Nenhum tamanho do catálogo é fornecido ao reconhecedor. As regras de Próximo, confirmação de par repetido e aplicação de estoque ficam com os módulos existentes; este serviço não grava banco.

`barcodeDecoder.decodeBarcodesFromDataUri(uri)` continua retornando uma lista de códigos. Sharp, ZXing e Tesseract agora executam em `scannerImageWorker.js`, num subprocesso local. A API recebe apenas resultado textual limitado; foto e revisão continuam sendo validadas no fluxo original. Nenhuma API paga.

## Limites e recuperação

- Um subprocesso de imagem por processo servidor; uma tarefa em execução. Um único worker Tesseract é reaproveitado dentro dele.
- `readImage` ocupado retorna `ocr_busy`; o agendador persistente decide a retomada. Não existe fila ilimitada oculta para OCR.
- Chamadas concorrentes ao adaptador de barcode usam FIFO de no máximo oito tarefas e 24 MiB de imagens aguardando; ultrapassar qualquer limite retorna `SCANNER_IMAGE_BUSY`. A FIFO é apenas amortecimento curto, não armazenamento durável de capturas.
- Prazo de execução inclui inicialização: 24 segundos para etiqueta; oito segundos para barcode. Ao exceder, o processo inteiro é encerrado e o chamador recebe falha recuperável. O substituto só nasce depois do evento de saída do PID antigo.
- Limite de entrada: 12 MiB por imagem, 24 milhões de pixels para processamento Sharp. Heap V8 do processo: 128 MiB; Sharp: uma thread e cache de 16 MiB.
- RSS observado a cada 250 ms: acima de 384 MiB, o processo é encerrado com `ocr_memory_limit`/`SCANNER_IMAGE_MEMORY_LIMIT`. **Esta amostragem não é um limite rígido do sistema operacional para memória nativa.** Há também reciclagem depois de 12 tarefas ou 30 segundos ocioso. Capacidade global é o número de processos consumidores multiplicado por esses limites; aumentar réplicas requer dimensionamento.
- Crash/erro de worker invalida o processo, sem terminar a API. Resultado IPC tem ID próprio; mensagem atrasada ou de processo anterior não resolve a peça seguinte.
- `scannerImageBroker.shutdown()` aguarda a saída do subprocesso e rejeita tarefas locais pendentes. IDs/fotos continuam no armazenamento durável do chamador para retomada.

Motivos recuperáveis de `readImage`: `ocr_busy`, `ocr_timeout`, `ocr_memory_limit`, `ocr_unavailable`. Entrada excedente/vazia: `photo_input_invalid`, sem retry automático. Barcode lança erro com `code` `SCANNER_IMAGE_BUSY`, `SCANNER_IMAGE_TIMEOUT`, `SCANNER_IMAGE_MEMORY_LIMIT`, `SCANNER_IMAGE_UNAVAILABLE` ou `SCANNER_IMAGE_INVALID`; falha técnica não pode ser apresentada como evidência de barcode conflitante.

## Verificação

- `node scripts/test-scanner-image-isolation.cjs`: subprocesso real preso em CPU, crash, mensagem simulada de RSS excedido (sem alocar memória excessiva), processo seguinte, FIFO/bytes, fechamento, PID ainda encerrando e mensagem atrasada. Inclui relógio no processo principal para provar que ele segue atendendo eventos durante o travamento do filho.
- `node scripts/test-scanner-archived-label.cjs`: 11 regressões de escala/geometria existentes.
- `node scripts/test-scanner-skechers-label.cjs`: referência modelo/cor na mesma linha; CM24 não vira BR24; worker reaproveitado; conflito de barcode impede OCR; PSM6 na mesma imagem; rasters EAN13, Code128 e ITF passando pelo subprocesso real.
- Corpus original: `node scripts/test-scanner-archived-corpus.cjs <labels.json> <resultado-local.json>`. Confere SHA-256 de cada foto antes de processar; não consulta banco nem movimenta saldo. Mede duração, motivo e maior intervalo entre eventos no pai. Arquivos privados não entram no Git. Resultado no projeto principal: `output/scanner-recovery-20261109/ocr-isolated-all17.json`.

Versões do ensaio: Node 22.23.4, Sharp 0.35.5, zxing-wasm 3.1.6 e Tesseract.js 7.0.0. As atualizações de bibliotecas não provam a causa do incidente anterior. Extração local de BR/código/referências não prova identidade fiscal completa, arquivo no servidor, aplicação no estoque ou recuperação das 33 leituras do telefone.

Ensaio integral concluído em 09/11/2026 19:02:22 UTC: seis extrações com código/BR/referência-modelo, uma Kappa com código/BR mas referência ainda pendente, dez pendências (nove prazos excedidos e uma falta de tamanho/referência). Os seis resultados completos preservaram os tamanhos anteriores comprovados. Maior intervalo observado no relógio do processo pai: 53 ms, com amostragem a cada 20 ms. Isso demonstra responsividade local durante este ensaio, não uma latência garantida da API ou do telefone. Relação por captura em `OCR-ISOLAMENTO-RESULTADO.md`, junto do JSON local.

## Alocações e regressões de resolução — revisão posterior de 09/11/2026

O processador prepara a versão normalizada somente se o primeiro passe da foto original não fornecer resposta. Quando necessária, essa versão conserva exatamente as dimensões e transformações anteriores; o mesmo buffer é reutilizado entre PSM11 e PSM6. O decoder fornece ao ZXing uma view do Buffer RGBA com seu byteOffset/byteLength, eliminando uma cópia integral de pixels sem modificar a origem. Os limites de 384 MiB/24 segundos não mudaram. Nenhuma dessas alterações promete eliminar todos os timeouts ou reduzir o RSS em cada processo.

Foram rejeitados dois experimentos de reduzir a resolução: 2400 pixels/4MP transformou uma extração parcial Fiber em timeout; 3000 pixels/5,1MP fez um controle Skechers BR41 retornar incorretamente 08. Esses limites experimentais **não estão no código final**. O original arquivado nunca foi alterado. Reduzir pixels exige repetir os controles reais, pois pode alterar letras, escalas e números reconhecidos.

O código final passou em seis controles reais Skechers (BR41/41/42/37/36/40), um Fiber completo (34/35), preservação da extração parcial Fiber 38/39 e rejeição de barcode divergente. Todas as referências completas anteriores e os hashes das imagens foram preservados. O texto parcial Fiber não comprova identidade completa. O ensaio usou Node 22.23.4, processo novo por foto, prazo real de 24 segundos, limite real de 384 MiB e amostragem de RSS a cada 250 ms; não consultou banco nem movimentou estoque. Relatório do projeto principal: `output/scanner-throughput-20261109/REVIEW.md` e `safe-results.json`.

`scripts/test-scanner-image-budget.cjs` verifica alocação sob demanda, resolução anterior idêntica, separação das rotações/PSM, conflito antes de OCR e equivalência byte a byte da view RGBA com deslocamento. A manutenção do veto de referências numéricas completas entre passes é coberta por `test-scanner-numeric-colour-reference.cjs`.
