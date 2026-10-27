# Plano — reconstrução física do estoque por loja

Data: 26/10/2026
Branch dedicada: `fix/stock-reconstruction-batch`
Baseline atual do TenisCash: `bfebff91784bcca42f87c8b406ff16101a36ed62`

Status desta etapa: implementação local concluída e validada com PostgreSQL temporário isolado; não publicada e não aplicada ao estoque oficial.

## Objetivo

Criar uma contagem física nova e isolada para cada loja ativa da Sports & Tennis (códigos LOJA02–LOJA06), sem usar como estoque novo as leituras de rodadas antigas, fotos, notas fiscais ou registros históricos. O repositório identifica a LOJA01/Baratão como outra empresa; ela fica fora deste lote. Uma loja ativa com código/grupo não reconhecido interrompe a abertura para impedir mistura empresarial. As contagens ficam em preparação enquanto o `StoreStock` oficial continua intacto. Só depois que todas as lojas da reconstrução estiverem conferidas, sem pendências e aptas, o sistema poderá substituir os saldos das lojas em uma única operação transacional e auditável.

Este trabalho prepara e testa o mecanismo. Não aplica a reconstrução ao banco oficial, não publica a versão e não substitui o estoque atual nesta etapa.

## Baseline examinado

- `StocktakeRound` representa uma loja; `StocktakeBipe` e `ProductCapture` ligados por `roundId` ficam separados do histórico legado.
- `startRound` devolve uma rodada antiga ainda aberta da mesma loja. Isso pode misturar uma solicitação de contagem nova com uma coleta velha.
- `finishRound` já substitui o saldo (não soma os bipes) e verifica pendências, divergências do saldo inicial e movimentos registrados, mas aplica uma loja de cada vez. Assim, parte da rede pode ser atualizada enquanto outras lojas ainda não foram conferidas.
- A conferência de movimentos consulta `StoreStockMovement`. A venda, troca e transferência já usam o livro-razão; ajuste manual e pedido Nuvemshop agora também registram movimentos com horário de execução. Edição de catálogo e realinhamento de fornecedor alteram a assinatura de variantes e, por isso, bloqueiam a aplicação se ocorrerem durante a reconstrução.
- `ProductSize.stock` é o total comprado e não pode ser alterado por esta reconstrução. O saldo físico por loja é `StoreStock`.
- O escopo empresarial não presume que toda linha de `Store` pertence à mesma empresa: `src/ai/prompts/system-prompts.js` e `src/services/metaCatalogSync.js` identificam LOJA01/Baratão como separado. A reconstrução inclui os códigos conhecidos LOJA02–LOJA06 e para se uma loja ativa fora desses grupos aparecer.
- O ajuste manual agora bloqueia a linha de saldo antes de ler e substituir o valor, mantendo o saldo e o lançamento de auditoria coerentes com uma venda concorrente.
- A versão atual do Railway inicia com `node src/index.js`; a `main` removeu o `prisma db push --accept-data-loss` do comando de inicialização. A reconstrução usa uma migração SQL aditiva e idempotente, executada sob advisory lock antes de qualquer rota `/api/stocktake`; se a estrutura não puder ser garantida, a API responde 503 sem registrar leitura nem tocar nos saldos oficiais. Nenhum `db push` foi executado em produção.
- A árvore original já tinha alterações locais não relacionadas e arquivos temporários não rastreados. O trabalho está sendo feito nesta worktree nova, criada de `HEAD`, para preservá-los.

## Implementação planejada

1. Adicionar uma entidade de reconstrução que fixa, na abertura, o conjunto ativo da Sports & Tennis (LOJA02–LOJA06) e cria uma rodada física nova para cada uma. Baratão/LOJA01 fica explicitamente fora; qualquer código ativo não classificado bloqueia o lote até existir um mapeamento de empresa. A criação não reutiliza rodadas antigas. Se uma loja ainda tiver uma rodada aberta, a operação informa qual rodada está em conflito e não inicia uma reconstrução parcial. A estrutura nova é adicionada por migração aditiva idempotente, antes de a API de bipagem consultar o Prisma Client atualizado.
2. Associar cada rodada à reconstrução. O scanner atual continua registrando cada unidade física na loja e rodada certas, com a chave de reenvio idempotente. Leituras sem código lido, código ambíguo, tamanho/variante não resolvidos e capturas pendentes continuam visíveis e impedem a conferência final. Nenhum dado antigo é importado para a contagem.
3. Permitir encerrar e revisar as coletas individualmente, mas impedir que uma rodada da reconstrução atualize o saldo oficial por conta própria. A tela de reconstrução mostra estado e pendências de todas as lojas do mesmo lote.
4. A conclusão exige todas as lojas do conjunto inicial, confirmação de contagem completa incluindo linhas com zero, coleta encerrada, contagens conferidas, ausência de itens pendentes, código efetivamente lido, catálogo sem alteração conflitante e nenhuma movimentação de estoque desde o início. Se qualquer condição falhar, nenhuma loja é atualizada.
5. Aplicar todos os saldos em uma transação única: contar substitui, não soma; variantes não contadas passam a zero nas lojas incluídas; lojas e tamanhos fora do conjunto permanecem intactos; `ProductSize.stock` permanece inalterado. Gravar movimentos de ajuste e o relatório de cada loja junto com a conclusão. Reenvio da mesma conclusão é idempotente.
6. Instrumentar ou bloquear os caminhos diretos de alteração de `StoreStock` identificados no baseline, para que uma movimentação durante a contagem nunca passe despercebida. A abertura e a aplicação obtêm bloqueio curto da tabela para estabelecer um limite consistente; operações de venda/transferência escrevem o evento depois da atualização do saldo. Se o catálogo de variantes mudar durante a reconstrução, bloquear a aplicação e exigir uma nova contagem; não inferir o destino de estoque antigo.

## Verificação obrigatória

- Testar que abrir lote cria uma rodada nova por loja da empresa correta, exclui Baratão/LOJA01 e não reaproveita nem importa dados antigos; loja ativa sem grupo conhecido deve bloquear a abertura.
- Testar que lote incompleto, leitura pendente, código ausente/ambíguo, conflito de loja, mudança de catálogo ou movimento de estoque bloqueia a aplicação e preserva integralmente todos os saldos oficiais.
- Testar aplicação de várias lojas em uma transação, zeros explícitos, preservação de `ProductSize.stock`, lançamento de auditoria, rollback em erro e reenvio idempotente.
- Executar testes de serviço, testes com PostgreSQL isolado e teste HTTP isolado. O teste DB exige a URL isolada em `ROUND_TEST_DATABASE_URL`; ela não estava configurada no baseline.
- Antes de qualquer publicação futura, seguir `docs/RELATORIO_ENCERRAMENTO_HOTFIX_BIPE.md`: revisão humana em PR, smoke test na versão publicada, verificação real do banco e monitoramento por 24 horas. Não declarar publicação ou substituição concluída sem esses resultados.

## Resultado verificado nesta branch

- `npx prisma validate` passou; `prisma db push --force-reset` foi executado somente no PostgreSQL temporário local criado para teste. A migração de produção não foi executada.
- O teste HTTP passou com a coluna e a tabela novas removidas primeiro do banco temporário: a primeira requisição `/api/stocktake` aplicou a migração e os endpoints responderam; uma segunda inicialização repetiu a migração sem duplicar objetos.
- Depois da migração, `prisma migrate diff --from-url ... --to-schema-datamodel prisma/schema.prisma --script` retornou migração vazia, confirmando que o banco temporário corresponde ao schema Prisma.
- `scripts/test-stocktake-rounds-db.js` passou contra esse banco: conflito de rodadas antigas, isolamento de leituras, Baratão excluído, loja desconhecida bloqueia, mudança de catálogo/movimento como bloqueios, rollback real após falha na segunda loja, substituição simultânea, zeragem, preservação do comprado e idempotência.
- `npm run test:stock-reconstruction-http` passou contra o PostgreSQL isolado: middleware exige token administrativo; loja desconhecida bloqueia; LOJA01 fica fora; a API cria uma rodada nova por loja, não importa leituras antigas, arquiva sem tocar no saldo e exige a confirmação de todas as lojas para aplicar a troca em lote.
- `scripts/test-stocktake-barcode-required.js`, `npm run test:sale-stock-ledger`, `npm run test:nuvemshop-stock`, `scripts/test-scanner-completion.js`, `scripts/test-scanner-reference.js` e `scripts/test-scan-transfers.js` passaram.
- `scripts/test-stocktake-transfers.js` e `scripts/test-scan-action-transfers.cjs` passaram com URL apontada ao mesmo PostgreSQL temporário isolado.
- O teste de CI `npm run test:mf-daily`, `scripts/check-requires.js` e `node --check` de todo `src/` passaram.
- A interface foi validada por análise sintática; não foi aberta no TenisCash publicado.

## Critério de conclusão desta etapa

Código, interface, testes e relatório de validação demonstram que as novas contagens permanecem separadas do saldo atual e que nenhuma atualização parcial é possível. A troca real de saldos é uma etapa posterior, dependente de dados físicos completos e de conferência/autorização da versão final.
