# Substituição de estoque — 09/11/2026

## Decisão expressa e escopo

Douglas respondeu: “Atualizar o estoque oficial a cada bipe”. Depois esclareceu: “É um novo estoque / O anterior será arquivado / Para depois aproveitar apenas o q quisermos de produtos, como roupas, acessórios / Para conferência e outros”. Fonte: conversa do projeto, 09/11/2026; horário exato das falas indisponível. Isto substitui a proposta de manter automaticamente roupa/acessório no saldo e de trocar o saldo somente ao fechar a contagem.

Uma loja é iniciada por vez em `/substituir-estoque.html`. O administrador confere a loja e o saldo que será arquivado e inicia a operação. O serviço guarda o saldo completo com identificação de cada variante, zera somente a loja escolhida e registra os movimentos em uma transação. Reenvio do mesmo início é idempotente; saldo alterado desde a prévia exige nova prévia. Preparar/publicar o recurso não inicia nenhuma loja.

O novo estoque é oficial desde o início. Cada leitura comprovada acrescenta uma unidade por movimento atômico, sem esperar fechar a conferência. Roupas e acessórios do arquivo antigo não são automaticamente reutilizados. O arquivo fica consultável/baixável para uma decisão posterior. Comprado, preços, XMLs e outras lojas permanecem fora desta operação.

## Identidade, leitura e evidência

`StocktakeRound.operationType=replacement` e `activeReplacementStoreId` separam a operação das rodadas antigas. Nenhum bipe histórico é importado. Rotas de escrita da nova operação exigem conta ativa e loja autorizada. O operador guardado offline deve corresponder à conta de envio; não se troca autoria silenciosamente.

Uma peça tem um `scanKey`, ID de bipe e capturas anteriores preservadas. O quadro original enviado é validado integralmente e arquivado sem recompressão. O servidor decodifica o código da foto e lê localmente BR/referência, confrontando variante, modelo e marca com cadastro e vínculo fiscal. Tamanho antigo confirmado no cadastro não substitui evidência da foto. Foto incompleta, código conflitante ou leitura ambígua continuam pendentes e não geram saldo.

O scanner só libera outra peça após **Próximo**. Outra peça de mesmo código pode contar; reenvio ou **Reler esta peça** mantém o ID e não conta outra unidade. A fila local é preservada para envio; a fila do servidor retoma validações pendentes. Exclusão autorizada reverte somente a unidade anteriormente aplicada, uma vez.

O arquivo é uma fotografia do saldo no início, não cópia destrutiva de cadastros. Vendas e entradas posteriores continuam no livro de movimentos. A conferência compara o saldo novo com esses movimentos; o fechamento não reaplica a soma de bipes e não apaga vendas. Inventários/reconstruções antigos não podem sobrescrever um novo estoque iniciado depois deles.

## Conferência das imagens de catálogo

Douglas respondeu à pergunta sobre uso do serviço visual com cobrança: **“Não, manter tudo sem API paga”**. Fonte: resposta explícita neste chat, 09/11/2026; horário exato indisponível. A implementação não consulta configuração de serviço pago, não importa o validador pago e não faz chamadas externas para análise de imagens.

O scanner decodifica código e lê BR/referência localmente. A conferência do catálogo detecta imagem ausente e uso da mesma imagem por outros cadastros, mantendo esses casos visíveis. Só reutiliza uma conferência visual explicitamente registrada por operador identificado para o mesmo produto, referência, cor e URL. Nome, modelo, cor ou URL diferentes invalidam esse reuso.

Sem evidência visual anterior, a imagem permanece pendente. A tela mostra a foto original da etiqueta, os dados do produto e a imagem cadastrada para conferência. O operador pode registrar que conferiu modelo e cor; isso não altera a imagem, o preço ou o estoque. A confirmação tem autoria e data, é ligada à identidade exata do cadastro e pode ser reaproveitada nas demais peças do mesmo cadastro. Nenhuma conferência visual humana é presumida ou registrada pelo agente sem examinar a imagem. A rotina gratuita não consegue provar automaticamente a identidade visual de todos os modelos; a pendência não é sucesso e bloqueia declarar a conferência final concluída.

## Verificação

Testes usam exclusivamente PostgreSQL `127.0.0.1:55329`, banco cujo nome começa com `stock_replacement_`. Nenhum teste cria bipes ou zera estoque de produção.

- `npm run test:stock-replacement`: arquivo de todo estoque (incluindo roupa), isolamento de loja, prévia desatualizada, quatro inícios concorrentes, oito reenvios concorrentes da mesma leitura, segundo par igual, venda posterior, exclusão idempotente, fechamento sem reaplicação, autorização HTTP, autoria original, foto original, pendências, proteção de imagem e seleção da rodada correta.
- `npm run test:scanner`: leitor, reconhecimento, integridade da imagem, persistência e 95 grupos de regressão das ações existentes.
- `test-scanner-round-poll.cjs`: falha temporária de consulta preserva a rodada correta, sem confundir modo/loja.
- Fotos reais antigas da Loja04 foram verificadas **somente localmente**, sem gerar bipes novos. Uma das seis permitiu confirmar código, referência e BR; cinco permaneceram pendentes (desfoque/OCR/código). Não se declara que qualquer foto pode ser lida, nem se substitui evidência por cadastro antigo. Relatório privado: `output/inventario-calcados-20261109/real-photo-local-check.json` no projeto de trabalho.

Estado de publicação e verificações da versão em produção serão registrados em `output/inventario-calcados-20261109/STATUS.md` do projeto. Este documento não prova que uma loja já começou ou que uma contagem física foi concluída.

## Recuperação de captura arquivada sem bipe — 09/11/2026

`stockReplacementCaptureRecovery` recupera o registro do mesmo evento quando a foto original já chegou ao servidor, mas ainda não existe a associação com `StocktakeBipe`. Não importa fotos soltas, notas fiscais ou contagens históricas. Exige rodada de substituição ativa em `counting`, loja correspondente, `scanKey` e revisão válidos, código presente, operador original ativo/autorizado e data da captura posterior ao início da rodada. O código é novamente decodificado da imagem arquivada; não é obtido por OCR nem inventado.

A decodificação ocorre fora da transação. A gravação trava a rodada e a chave da leitura, revalida foto/revisão/contexto e preserva autoria, `capture.createdAt` como horário do bipe, código e foto. Bipe existente na mesma chave é somente vinculado. Outro evento ativo com o mesmo código exige confirmação de repetição; a recuperação não a presume. Produto desconhecido permanece pendente; conflito de variantes não escolhe o primeiro cadastro. A resolução reutiliza os vínculos canônicos e aliases exatos do catálogo.

O serviço não aplica saldo: após o commit, encaminha o bipe para a verificação normal de código, BR e referência. A execução é feita pela fila durável descrita abaixo. A conciliação periódica apenas agenda eventos arquivados, carrega uma foto por vez e percorre páginas de IDs para que uma pendência permanente não impeça as posteriores. Nenhuma foto original é substituída ou apagada.

No mesmo ajuste, a confirmação Skechers reconhece os prefixos internos `GTM`, `GTW`, `T` e `R`, conservando modelo e cor completos. Referência só de modelo ou alias antigo de outra cor não autoriza confirmação. Classificação ACTVITTA com evidências divergentes permaneceu inalterada e pendente.

Testes adicionados a `npm run test:stock-replacement`: `test-stock-replacement-reference.cjs` e `test-stock-replacement-capture-recovery.cjs`. O segundo usa apenas PostgreSQL local `roundtest@127.0.0.1:55329/stock_replacement_*`, inclusive `stock_replacement_ci`. Cobrem reenvios concorrentes, eventos repetidos, vínculo existente, catálogo desconhecido/ambíguo/consolidado/alias, captura excluída, loja/rodada/operador inválidos, revisão/foto alteradas durante a decodificação, autorização revogada, foto inválida/código divergente, preservação da imagem e saldo zero antes da verificação. Implementação e testes locais não comprovam publicação nem recuperação das fotos do telefone.

## Fila PostgreSQL durável — implementação local de 09/11/2026

`stockReplacementQueue` usa pg-boss 12.38.1 e requer Node 22.12 ou superior dentro da versão 22 adotada pelo projeto. O schema `stock_replacement_queue` guarda jobs da fila `replacement-capture-v1`. O payload contém identificadores, revisão e hashes; nunca a foto original, OCR completo ou credenciais. As imagens continuam vinculadas às capturas existentes.

No recebimento de uma foto da Substituição, a gravação do original e a criação do job usam **a mesma transação PostgreSQL**, com adapter explícito do cliente Prisma transacional. Uma falha ao criar o job reverte essa gravação, e o aparelho mantém sua leitura para reenvio. O bootstrap da fila ocorre antes de abrir a transação. Uma conciliação paginada encontra eventos já arquivados sem trabalho recente, inclusive anteriores à implantação, sem importar unidades novas nem bloquear os demais por uma pendência.

O worker revalida loja, rodada, operador, código, foto e revisão. A recuperação de captura órfã conserva as restrições anteriores. Decodificação e OCR ficam fora da transação de estoque. O resultado só pode aplicar +1 após comprovar código, BR, referência e variante. Aplicação, movimento, marcação do bipe e confirmação do job são gravados numa transação curta. A confirmação usa o ID **e a tentativa reclamada**, impedindo que um worker com lease expirado confirme a tentativa nova: se perdeu a posse, toda a transação do saldo é revertida. Reenvio ou resposta perdida não reaplica uma unidade já confirmada.

Há um worker por processo, lease de 120 segundos e heartbeat de 15 segundos. Falhas transitórias de decodificação/OCR usam até oito retries, espera inicial de 15 segundos e backoff limitado a 300 segundos. Uma peça pendente não mantém outra peça esperando. Reavaliações posteriores da conciliação respeitam intervalo mínimo de cinco minutos e percorrem IDs, sem acumular todas as fotos na memória. O cron legado de etiquetas não processa as rodadas de Substituição; não existe Set de execução paralelo para esse fluxo. Pendência de catálogo continua distinta de confirmação visual humana.

Interfaces: `get(db).start()`, `enqueue(db,bipeId)`, `get(db).reconcile()`, `health(db,{roundId,storeId})`, `stop(db)` e `stopAll()`. Saúde retorna contagens por estado de **jobs**, idade do mais antigo e metadados de tentativas, sem payload; esses totais não são número de pares. Shutdown encerra o worker/pool de forma graciosa. Jobs não concluídos permanecem recuperáveis no PostgreSQL.

Correção dos estados de pendência de 09/11: a conclusão de um job com pendência agora grava `ProductCapture.status=pendente`, motivo ligado à revisão e `StockReplacementCheck` quando há bipe correspondente. Esses registros e o ACK do job compartilham transação e fencing da tentativa. Uma ligação HTTP tardia conserva o motivo, em vez de voltar a `processando`; recaptura e rodada cancelada invalidam o resultado antigo. A consulta de status também apresenta resultados anteriores de jobs somente quando revisão e hash ainda correspondem à foto atual. Não há alteração de saldo por registrar pendência. Nenhum código legível, vários códigos e código divergente têm motivos distintos. As leituras de contexto da fila/recuperação deixam de transportar o arquivo `baseline` de toda a loja para cada peça.

`scripts/test-stock-replacement-pending.cjs` verifica em PostgreSQL isolado foto órfã com registro HTTP posterior, classificação pendente, resposta de status, preservação da revisão, rodada cancelada, rollback por lease vencida e ausência de movimento de estoque em todos esses casos. Esse teste não comprova uma nova bipagem física nem publicação.

`scripts/test-stock-replacement-queue.cjs` passou com Node 22.23.4 e PostgreSQL local isolado: rollback conjunto foto/job; oito reenvios; parada/reabertura da fila; resposta perdida; processamento concorrente do mesmo evento; segunda peça física registrada; foto com revisão substituída; tentativa invalidada e reclamada novamente com rollback do saldo do worker antigo; erro de memória/OCR sem prender peça seguinte; operador revogado; saúde sem imagens/segredos; e worker pg-boss real até commit e parada graciosa. Os testes de serviço, HTTP e catálogo também passaram após a integração. A simulação de perda de lease invalida a tentativa pela API de falha/reclaim, sem afirmar teste físico de queda de energia. Esta seção registra implementação e testes locais, não publicação ou recuperação integral do aparelho.
