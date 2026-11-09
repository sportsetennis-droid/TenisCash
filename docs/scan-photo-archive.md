# Arquivo de imagens dos bipes

Pedido de Douglas em 08/11/2026: “Eu quero que fique salvo e arquivada cada bipe com imagem”. Horário exato da mensagem indisponível.

- Recebimento e transferência: a câmera salva o quadro decodificado primeiro no aparelho (IndexedDB; fallback localStorage). O envio guarda bytes da foto no PostgreSQL, ligados ao ID imutável do bipe, lote, código, operador e horário. Produto/tamanho continuam no próprio bipe. OCR, quando disponível, acompanha a foto sem substituir a imagem original.
- Reenvio da mesma imagem usa chave única bipe + SHA-256. Uma nova foto da mesma peça fica preservada sem acrescentar bipe. Remover uma leitura da contagem não apaga sua evidência.
- O histórico permite abrir as fotos mediante autenticação e autorização de loja. A resposta binária usa cache privado/no-store.
- Leitura nova no recebimento/transferência sem foto fica pendente. Confirmação de lote com `photoRequired` e sem foto é recusada no servidor. Uma foto salva somente no aparelho é mostrada como aguardando arquivamento; retorno da conexão, autenticação e reabertura retomam o envio.
- Inventário pela câmera: a leitura automática passa pelo mecanismo existente de `ProductCapture` e `/api/stocktake/etiqueta`, usando o quadro que decodificou o código. Fotos manuais e recapturas continuam preservadas. O serviço antigo de identificação por código continua disponível para compatibilidade e não inventa fotografia para entradas de texto.
- Nenhum estoque é movimentado por salvar uma imagem. Foto não comprova recebimento aplicado nem resolve tamanho sem evidência.
- Registros antigos sem imagem continuam sem imagem. Não gerar fotografias artificiais ou usar foto de outra peça. Abas abertas antes desta versão precisam ser recarregadas para carregar a mudança.

## Implantação

Aplicar somente a migração aditiva `20261109010000_scan_action_photos` antes de publicar o código; ela acrescenta tabela de fotos e coluna de controle, preservando dados anteriores. Não executar `db push` indiscriminado em produção. Não inserir bipes fictícios no banco real para testar.

## Validação

`npm run test:scanner` inclui captura do inventário, integridade de JPEG/PNG/WebP, nove casos de geometria BR e 95 grupos da interface de ações, usando DOM/câmera/rede simulados. O visualizador é testado com fotos pendentes, fotos arquivadas, logout e respostas atrasadas. `scripts/test-scan-action-photos.cjs` exige PostgreSQL local isolado e testa bytes reais de imagem, concorrência, recapturas, autorização, HTTP e trava de confirmação. Históricos e transferências têm testes próprios no mesmo ambiente isolado. Isso não constitui teste físico com o telefone do operador.

Teste solicitado em 08/11/2026 encontrou JPEG truncado aceito porque o cabeçalho continuava legível. O servidor agora decodifica todos os pixels antes de reconhecer o arquivamento; os bytes originais são preservados, sem converter a imagem. Imagem incompleta permanece pendente para reenvio da mesma peça.

## Vinculação automática pela foto arquivada

Ordem de Douglas: “Então vc precisa vincular isso automaticamente”, após verificar a captura real do Nano X4 na Loja 07. A imagem já arquivada é processada no próprio servidor, com ZXing e Tesseract locais e o modelo de idioma já hospedado pelo TenisCash, sem API paga nem envio a serviço de OCR externo. O texto recebido do navegador não é tratado como confirmação visual: o servidor decodifica o código e lê os pixels originais.

Somente EAN único na imagem igual ao bipe, tamanho BR explícito com geometria e confiança suficientes, referência compatível e vínculo inequívoco com produto canônico em NF-e de entrada permitem aprender o barcode. No formato Reebok documentado, a referência de nove dígitos e o BR observado precisam concordar com a referência fiscal completa; o BR não é deduzido do sufixo. Outra escala, ambiguidade, cadastro conflitante, referência diferente, transferência incompatível, leitura removida ou lote fechado permanecem pendentes.

O vínculo reaproveita a variante correta; variante comprovada ausente nasce com estoque zero. IDs, quantidade, loja, lote, foto, estoque comprado e XML ficam preservados. A evidência e o resultado ficam em AdminAction e no contexto do produto. O mesmo bipe recebe a identificação; reenvio antigo não desfaz a resolução comprovada. Falha temporária do leitor mantém a foto arquivada e retoma a identificação na fila. Abas antigas devem ser recarregadas para usar a atualização automática da lista.

Teste completo com imagem real local: `TRANSFER_TEST_DATABASE_URL` deve apontar para PostgreSQL localhost e `SCAN_PHOTO_FIXTURE` para a imagem de teste; executar `node scripts/test-scan-photo-link.cjs`. A foto particular não é incluída no repositório. Verifica vínculo, conflito, autorização, repetição, rascunho atrasado, foto original, estoque inalterado e tamanho novo sem estoque.

## Uma peça por vez; próxima somente por clique — 09/11/2026

Ordem de Douglas: “Eu quero que o sistema leia uma por vez e só após o operador clicar em próximo é que vai ler a próxima”. Ele esclareceu que duas peças podem ter etiquetas iguais e que o operador deve controlar a passagem manualmente. Esta ordem substitui o avanço automático de recebimentos e transferências.

Após capturar código e foto, o painel da peça permanece aberto e o leitor fica pausado. Produto reconhecido, erro de identificação, término de consulta/OCR e arquivamento de foto não liberam a câmera para outra peça. Somente PRÓXIMO ou PRÓXIMO — MANTER PENDENTE autoriza uma nova unidade. Código igual é aceito para outra peça após esse clique; não se exige detectar uma mudança visual para substituir a decisão do operador. RELER A MESMA PEÇA preserva o ID e a quantidade, mantendo as imagens de cada tentativa. Consulta tardia pode atualizar a peça original, mas não avançar nem alterar a peça seguinte; um resultado atrasado da captura manual também é descartado se pertence ao ciclo anterior.

O inventário já mantém sua captura pausada até Próximo; seu fluxo foi preservado. Bipes anteriores, quantidades, cadastros, preços, estoque e confirmação de recebimento não são alterados por esta correção. Recarregar a página carrega `bipar-actions.js?v=20261109-manual-next-1`.

## Próximo após guardar código e foto no aparelho — 09/11/2026

Douglas corrigiu a espera na Substituição de estoque: “Depois que escaneiou já tem que aparecer o próximo e o sistema interno fica trabalhando”. O horário exato da mensagem não está disponível. O clique continua manual; a alteração é no momento em que Próximo fica disponível.

Em `bipar.html`, o compromisso local da imagem original, do código e da revisão libera Próximo sem esperar o upload ou a identificação. A confirmação dessa transação já atualiza o painel. Foto ainda somente em memória, erro de armazenamento ou código ausente não liberam uma nova peça. Releitura manual sem código retoma a mesma peça, depois de preservar sua imagem. O estado “foto salva neste aparelho” é distinto de “imagem salva no sistema” e não afirma estoque aplicado.

O envio e o OCR seguem na fila existente. Cada resultado fica vinculado ao ID e à revisão originais; outra unidade com código igual recebe outro ID somente após o clique. Não houve mudança de saldo, de rodada, de regra de validação nem ativação de serviço pago por esta correção.

`scripts/test-scanner-local-next.cjs` executa as funções reais da fila, captura e painel em ambiente isolado: mantém o compromisso local, upload e OCR artificialmente pendentes; verifica o botão antes/depois do salvamento; captura outro par de código igual durante o envio; entrega resultados atrasados; provoca falha de armazenamento e retoma sem perder nem duplicar peças. `test-scanner-inventory-photo.cjs` verifica também a proteção antes da gravação local e a recaptura. Estes testes não equivalem a teste físico no telefone.

Regressão isolada: 100 quadros repetidos/alternados não adicionam peça; clique duplo sem peça intermediária não acumula autorizações; dois pares de código igual após Próximo têm IDs próprios; sequência dos códigos problemáticos da Loja 04 permanece em um bipe e permite recapturar a mesma unidade; atraso de consulta, OCR, foto e decodificação manual não avança a câmera. Fotos, troca de operador/loja, falhas de armazenamento e bloqueio de confirmação com pendências continuam cobertos. Nenhum bipe fictício inserido em produção para esses testes.

## Fila única sem retenção de todas as imagens — 09/11/2026

Douglas relatou duas saídas da página durante a sequência e depois perguntou: “Pq vc deixou assim? Pq vc não fez apenas um funil que passa todos?”. A captura de tela enviada às 14:35 no telefone mostra **33 leituras no aparelho**, 17 confirmações de foto no sistema e 23 enviando; os contadores se sobrepõem e não devem ser somados. Consulta de produção em 2026-11-09 17:37:52.319117+00 encontrou 17 capturas com foto, 11 bipes e seis fotos ainda sem bipe na Loja 04, rodada 20. Nenhuma aplicação ao estoque estava confirmada nesse corte. A consulta não consegue enxergar fotos ainda somente no telefone.

A fila existente agora carrega apenas metadados e busca uma foto original por vez para upload, OCR ou prévia. Checkpoints não duplicam todos os base64; ao avançar, a prévia anterior sai da memória, mas permanece no IndexedDB. Recapturas mantêm todas as revisões arquivadas. Uma atualização vinda de outra aba descarta a cópia antiga em memória antes de adotar a nova referência. OCR local é serial e libera os canvases temporários, assim como a captura da câmera do inventário. Isso corrige acúmulos comprovados no código; sem log de falha do iOS, não comprova por si só a causa das duas saídas do telefone.

Todos os bipes usam a mesma fila persistente. O upload escolhe a peça elegível com tentativa mais antiga; erro mantém a peça com espera própria de 2 a 30 segundos, sem impedir o envio das outras. O mesmo ID, foto, loja, operador e rodada são mantidos nos reenvios. Próximo continua manual e disponível após salvar localmente. Na rota de foto, foi corrigida a ausência de `product.id` na consulta que segue vínculos explícitos de cadastros unificados: esse erro impedia seis códigos observados de registrar o bipe, embora a foto estivesse arquivada. Produto encontrado e foto salva continuam distintos de estoque aplicado.

Testes isolados: 203 leituras/fotos preservadas durante upload retido, apenas a imagem ativa em memória, nenhuma imagem nos checkpoints, recarga dos 203 originais; 80 imagens no IndexedDB com carregamento individual e recaptura preservada; liberação de 100 quadros e das imagens/crops/rotações de OCR em sucesso e erro. A fila é exercitada com uma peça ativa que falha, outras que seguem e posterior reenvio do mesmo ID/foto, respeitando a espera. Teste HTTP com PostgreSQL local reproduziu o erro do cadastro unificado antes da correção e confirmou o mesmo bipe em dois envios depois, sem aplicar estoque prematuramente.

Esses testes não equivalem a teste físico no iPhone. A publicação e a contagem posterior devem ser verificadas separadamente em `output/scanner-memory-20261109/` do projeto operacional. Não reiniciar as sete rodadas, não limpar armazenamento do navegador e não pedir nova bipagem das 33 peças para retomar o envio.
# Recuperação de fila e confirmação por etapa — 09/11/2026

Correção solicitada após fotos preservadas sem efeito no estoque e contadores sobrepostos. A fila de fotos retoma depois da restauração local, retorno da internet, retorno à página e carregamento da rodada/autenticação original, sem abrir câmera ou acionar Próximo. Metadados antigos sem operação aguardam confirmação da rodada e loja originais. A identidade é revalidada depois de carregar a foto do IndexedDB e antes do envio. HTTP401 aguarda a mesma identidade;400/403/409 reais permanecem em revisão. Tokens não são gravados nos metadados da leitura.

O resumo da câmera divide as leituras da rodada atual em quatro estados exclusivos: no aparelho/aguardando envio, recebidas/em conferência, aplicadas e pendências/erros. A soma corresponde aos IDs ativos, sem deduplicar códigos iguais. Foto salva e produto identificado não são aplicação de estoque. O indicador de aplicação exige a confirmação `appliedToStock` do servidor, preservada no registro local.

Regressões: `test-scanner-outbox-recovery.cjs`, `test-scanner-recent-read-ui.cjs` e suíte `test:scanner`. Foram exercitados contexto/login tardios, troca de operador durante a leitura da foto, resposta401 atrasada, retomadas simultâneas, preservação das fotos e soma exclusiva dos estados. São testes isolados; publicação e recuperação das leituras reais exigem evidência específica e não são presumidas por este documento.
