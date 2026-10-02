# Transferência da sequência de bipagem

Em `bipar.html`, a seção **Transferir mercadoria bipada** reúne os novos bipes deste navegador, separados por loja e rodada. Não seleciona implicitamente todo o inventário da loja. A sequência sobrevive ao recarregamento; limpar a lista visual não a apaga. “Começar nova sequência” retira conscientemente os bipes do lote, sem excluir seu histórico.

O operador entra com a conta pessoal, escolhe o destino, confere produto, tamanho, quantidade e saldo e confirma o lote. A permissão é reconsultada no servidor. A escolha livre do nome do vendedor na bipagem não autentica uma transferência.

## Separação dos registros

- `StocktakeBipe` e `ProductCapture`: evidência da contagem física; conservam origem, rodada e identificadores.
- `StoreStock`: saldo movimentado por loja. Uma confirmação válida gera débito na origem e crédito no destino, com movimentos pareados.
- `ProductSize.stock`: quantidade comprada; a transferência não a modifica.
- `StocktakeTransferScan`: vínculo único de cada bipe à transferência, com variante e código preservados.

Uma foto ou um bipe não cria estoque. Saldo insuficiente, código/variante/tamanho pendentes, produto inativo, leitura excluída/aplicada ou já transferida bloqueiam todo o lote. Não há transferência parcial silenciosa. EAN repetido em bipes distintos representa peças distintas; o fluxo de bipagem mantém sua confirmação de repetição.

`POST /api/scan-transfers/batch-preview` recebe origem, destino, rodada e seleção explícita (`bipeIds`/`scanKeys`). A confirmação usa `/batch-confirm`, `reviewToken` e um UUID de requisição persistido antes do envio. Mudanças na seleção, cadastro ou estoque exigem nova conferência. Repetir a mesma confirmação recupera o resultado, sem repetir os movimentos.

O lote é gravado numa transação Serializable com revalidação e travas. O limite é de 1.000 leituras por lote. Os endpoints não devolvem custos nem campos fiscais; segue a modalidade não fiscal do módulo de transferência por câmera existente.

## Reconciliação

Os bipes permanecem na origem como histórico, não são replicados como recebimento físico no destino. O modelo de verificação desconta saídas e mantém entradas ou movimentos intercalados pendentes de reconciliação. O fechamento de inventário continua bloqueado quando houve movimentações durante a rodada; esta função não sobrescreve o estoque usando a contagem.

## Verificação

`scripts/test-stocktake-transfers.js` exige PostgreSQL local isolado em `TRANSFER_TEST_DATABASE_URL`. Abrange validações, saldo, concorrência, idempotência, preservação das evidências e rollback completo diante de falha depois do débito. Manter também as verificações do módulo existente em `scripts/test-scan-transfers.js`.
