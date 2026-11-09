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

O código de barras e o OCR das etiquetas continuam locais, sem API paga. O reuso do serviço visual de catálogo foi preparado, mas depende da resposta expressa à pergunta enviada a Douglas sobre cobrança. Sem autorização, `Config.key=stock_replacement_catalog_vision` não é habilitado e **nenhuma chamada paga é feita por este recurso**.

Quando autorizado, o valor JSON `{ "enabled": true }` permite o validador de catálogo já existente, separado da leitura das etiquetas. Aceitação exige produto correto, cor correta e nota >=9. O resultado registra método, fornecedor, custo, instante, modelo/cor/URL e impressão digital desses dados. Só a mesma identidade de produto/imagem pode reutilizar a conferência. Imagem ausente, serviço indisponível, resposta incerta ou mudança de modelo/cor/URL permanecem pendentes e impedem declarar a conferência final concluída. Aprovação automática não equivale a aprovação visual pessoal de Douglas.

## Verificação

Testes usam exclusivamente PostgreSQL `127.0.0.1:55329`, banco cujo nome começa com `stock_replacement_`. Nenhum teste cria bipes ou zera estoque de produção.

- `npm run test:stock-replacement`: arquivo de todo estoque (incluindo roupa), isolamento de loja, prévia desatualizada, quatro inícios concorrentes, oito reenvios concorrentes da mesma leitura, segundo par igual, venda posterior, exclusão idempotente, fechamento sem reaplicação, autorização HTTP, autoria original, foto original, pendências, proteção de imagem e seleção da rodada correta.
- `npm run test:scanner`: leitor, reconhecimento, integridade da imagem, persistência e 95 grupos de regressão das ações existentes.
- `test-scanner-round-poll.cjs`: falha temporária de consulta preserva a rodada correta, sem confundir modo/loja.
- Fotos reais antigas da Loja04 foram verificadas **somente localmente**, sem gerar bipes novos. Uma das seis permitiu confirmar código, referência e BR; cinco permaneceram pendentes (desfoque/OCR/código). Não se declara que qualquer foto pode ser lida, nem se substitui evidência por cadastro antigo. Relatório privado: `output/inventario-calcados-20261109/real-photo-local-check.json` no projeto de trabalho.

Estado de publicação e verificações da versão em produção serão registrados em `output/inventario-calcados-20261109/STATUS.md` do projeto. Este documento não prova que uma loja já começou ou que uma contagem física foi concluída.
