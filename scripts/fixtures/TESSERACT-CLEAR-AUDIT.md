# Tesseract 7: limpeza de imagem antes do próximo passe

Data do diagnóstico: 10/11/2026. Estado: experimento isolado; não habilitado no aplicativo e não comprovado em produção. Esta frente não executou OCR. Ambiente-alvo informado: Linux, Node 22.14, Sharp 0.35.5/libvips 8.18.7, Tesseract.js 7, limite de 384 MiB e 24 s.

## Contrato confirmado no código exato

O pacote instalado é `tesseract.js@7.0.0` com `tesseract.js-core@7.0.0`. O core aponta para o submódulo Tesseract no commit `2a9c1c49c360462733c386d2a44fcd22c4e21411`. O adaptador do Tesseract.js tem licença Apache-2.0, não MIT. O worker diagnóstico contém integração própria com os módulos oficiais, sem cópia/modificação de arquivos do pacote.

Fontes primárias:

- [Core7 e submódulos](https://github.com/naptha/tesseract.js-core/tree/v7.0.0)
- [TessBaseAPI exata](https://raw.githubusercontent.com/Balearica/tesseract/2a9c1c49c360462733c386d2a44fcd22c4e21411/src/api/baseapi.cpp)
- [ImageThresholder exato](https://raw.githubusercontent.com/Balearica/tesseract/2a9c1c49c360462733c386d2a44fcd22c4e21411/src/ccmain/thresholder.cpp)
- [Tesseract::Clear exato](https://raw.githubusercontent.com/Balearica/tesseract/2a9c1c49c360462733c386d2a44fcd22c4e21411/src/ccmain/tesseractclass.cpp)
- [Binding WebIDL7](https://raw.githubusercontent.com/naptha/tesseract.js-core/v7.0.0/javascript/tesseract.idl)
- [Dispatcher7](https://raw.githubusercontent.com/naptha/tesseract.js/v7.0.0/src/worker-script/index.js)
- [Adaptador Node7](https://raw.githubusercontent.com/naptha/tesseract.js/v7.0.0/src/worker-script/node/index.js)
- [Seleção original de core7](https://raw.githubusercontent.com/naptha/tesseract.js/v7.0.0/src/worker-script/node/getCore.js)
- [Licença upstream](https://github.com/naptha/tesseract.js/blob/v7.0.0/LICENSE.md)

`SetImageFile`, linhas 580–598 da fonte exata, chama `InternalSetImage`/`ClearResults`, decodifica `/input` com `pixRead`, trata alpha e só então chama `thresholder_->SetImage`. O thresholder destrói sua Pix anterior dentro desse último método. Assim, a decodificação da nova imagem pode coexistir com a Pix anterior e a imagem original ainda referenciada. Isso é sobreposição de vida útil comprovada pelo código, não prova de vazamento progressivo.

`TessBaseAPI::Clear`, linhas 1857–1865, limpa o thresholder, os resultados e a referência à imagem original. `Tesseract::Clear`, linhas 481–495, libera imagens derivadas, splitter e estado geométrico. Não chama `End`, `Init`, `ResetAdaptiveClassifier` ou `ResetDocumentDictionary`; não remove `lstm_recognizer_` nem reinicializa parâmetros. Os resets são métodos separados. O binding WebIDL contém `void Clear()` e o bundle instalado disponibiliza `TessBaseAPI.prototype.Clear`.

## Experimento proposto

`tesseract-clear-worker.cjs` é um workerPath explícito. Ele usa dispatcher, seleção de core, gzip, fetch e cache originais. A factory original recebe as mesmas opções e retorna o mesmo módulo. A única mudança funcional é envolver `TessBaseAPI.prototype.SetImageFile`: chama `this.Clear()` imediatamente antes do método original, com receptor, argumentos, retorno e exceções preservados. Não altera OEM1, modelo, PSM, imagem/pixels, saídas, confiança, limites ou quantidade de passes. Não troca o core e não usa `require.cache`.

Selecionar esse arquivo apenas no cenário C do harness diagnóstico, por `createWorker(..., {...opcoesExistentes, workerPath: caminhoAbsoluto})`. O processo deve ter cwd do aplicativo com as dependências instaladas; alternativamente, `SCANNER_TESSERACT_APP_ROOT` pode apontar para esse diretório. O worker exige exatamente as versões auditadas 7.0.0 e falha se o contrato de API estiver ausente. O primeiro SetImageFile também chama Clear, quando ainda não existe imagem anterior; isso mantém um único caminho e não chama Init novamente.

Executar baseline e cenário Clear em processos Linux novos, sequencialmente, mantendo originais/hash, pixels, OEM 1, parâmetros, core, 384 MiB e 24 s. Registrar pico RSS/cgroup, tempos por passe/total e respostas text+blocks/BR/referência/EAN. Só considerar integração após preservar positivos e vetos. Resultado sintético Linux comprova apenas o mecanismo/consumo naquele ensaio; não substitui regressão das fotos reais.

## Limites e alternativas auditadas

- Clear devolve blocos ao allocator do WASM; não encolhe memória linear já crescida. A hipótese é evitar o próximo crescimento/pico, não exigir queda imediata de RSS. Comparação em um processo já aquecido pelo baseline contamina o ensaio.
- O bundle7 não expõe HEAPU8/HEAP8 como contrato público; não presumir essas métricas. RSS/cgroup são as medidas do limite real. [Contrato do crescimento Emscripten](https://github.com/emscripten-core/emscripten/blob/main/system/include/emscripten/heap.h).
- Não há worker.clear/reset/clearCache público. `removeFile('/input')` libera apenas o arquivo comprimido em MEMFS, não a Pix reconhecida. `cacheMethod:'none'` trata cache de traineddata, não imagens.
- `reinitialize` faz End e cria outra TessBaseAPI no mesmo módulo WASM; pode resetar parâmetros e precisa recarregar o modelo. Não encolhe automaticamente memória WASM e não isola a hipótese de sobreposição. O código também não destrói explicitamente o wrapper da API anterior.
- `ClearPersistentCache` elimina dicionários globais não usados, não as imagens da API ativa. Não resolve essa ordem de alocação.
- `ClearAdaptiveClassifier` reseta adaptação/dicionário e não deve ser usado neste ensaio. Nos bundles LSTM 7 instalados há método JS que referencia um stub de função ausente: typeof function não prova implementação segura.
- O wrapper público `worker.terminate()` da versão 7 chama o terminador Node sem aguardar a Promise do Worker nativo. Um ensaio de reciclagem que não espera o evento exit pode sobrepor workers; este ensaio não recicla nem modifica esse comportamento. [createWorker7](https://raw.githubusercontent.com/naptha/tesseract.js/v7.0.0/src/createWorker.js), [terminadorNode7](https://raw.githubusercontent.com/naptha/tesseract.js/v7.0.0/src/worker/node/terminateWorker.js).

## Verificação sem OCR

`test-tesseract-clear-worker.cjs` usa VM e objetos simulados; não carrega Tesseract/WASM nem imagens. Verifica ordem Clear→SetImageFile, argumentos/receptor/retorno/exceções, ausência de End/Init/resets, decoração única, dispatcher/adapter originais, fetch/cache e rejeição de versões/API não auditadas. Executado com Node 22.23.4 portátil no Windows: 29 verificações aprovadas. Os hashes são reportados separadamente na entrega. Isso valida o contrato JS simulado; consumo e equivalência do OCR no Linux continuam pendentes do cenário C.
