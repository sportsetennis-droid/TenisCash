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
