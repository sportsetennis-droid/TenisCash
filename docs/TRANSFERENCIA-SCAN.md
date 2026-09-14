# Transferência por scan

Publicado em `/transferencia`. Usa conta pessoal ativa de vendedor, gestor ou administrador. Contas institucionais e clientes não movimentam estoque por este módulo. Vendedores transferem a partir de `storeId`/`storeIds` vinculadas à sua conta; gestores e administradores podem operar as lojas ativas.

1. Abrir câmera e escanear uma etiqueta, em qualquer orientação. O leitor local roda em Worker; OCR local tenta referência e tamanho quando necessário. Não há API paga.
2. Consultar saldo físico em `StoreStock` do produto e tamanho. Se houver várias origens possíveis, escolher a origem; o GTIN não serializa cada peça. A origem única é selecionada automaticamente.
3. Escolher uma loja diferente como destino e confirmar uma peça. A transação baixa uma unidade na origem e acrescenta uma no destino imediatamente. Não existe etapa de recebimento neste primeiro módulo.
4. “Desfazer última” reverte somente a última transferência ativa da própria pessoa, mediante saldo no destino. O registro fica cancelado, e dois movimentos registram a devolução. Repetir o pedido de desfazer é idempotente.
5. Histórico pessoal: total da sessão e total do dia em America/Sao_Paulo, líquidos dos cancelamentos; lista das últimas 100 operações do dia. Não aceita `userId` fornecido pelo cliente.

## Persistência e limites

- Reaproveita `StockTransfer`, `StockTransferItem` e `StoreStockMovement`, sem alterar o schema.
- O UUID da confirmação é o ID da transferência. Retentativas com o mesmo UUID devolvem o mesmo resultado. Conteúdo diferente ou dono diferente com o mesmo ID é rejeitado.
- `note` contém JSON de origem `camera-transfer-v1`, sessão e código lido. Código legível sequencial alocado sob advisory lock, compartilhado por confirmação e desfazer neste módulo. Outro futuro criador de StockTransfer deve usar a mesma trava ou alocação centralizada.
- Trava os saldos em ordem estável e verifica disponibilidade antes da baixa. Não cria saldo negativo nem mexe em `ProductSize.stock`, custo, preço, inventário ou capturas.
- Fiscal explicitamente desativado pelo pedido do usuário em 14/09/2026: `fiscalStatus=skipped`, sem `fiscalDocId`, sem emissão ou agendamento fiscal.
- Transferências geram movimentos auditáveis. O fechamento de inventário existente continua detectando movimentações durante a coleta e exigindo reconciliação; o módulo não contorna essa proteção.
- Resultado de envio incerto fica em fila local por usuário e é consultado/repetido com o mesmo ID antes de outra leitura. Nunca solicita rebipar para repetir o envio.
- Não transfere identificação ambígua, tamanho técnico ou saldo não aplicado de uma rodada de inventário aberta.

## Verificação

`TRANSFER_TEST_DATABASE_URL` deve apontar para PostgreSQL isolado em localhost. `node scripts/test-scan-transfers.js` testa concorrência, oito retentativas, saldo da última unidade, escopo por pessoa/loja, sessão/dia, desfazer idempotente e ausência de alteração no comprado/inventário/fiscal. Cria fixtures apenas nesse banco de testes.

Também verificado no Chrome com câmera de teste alimentada por foto: detecção → origem → destino → confirmação → histórico → desfazer. Nenhuma transferência de teste em produção.
