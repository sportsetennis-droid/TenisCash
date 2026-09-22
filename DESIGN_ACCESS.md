# Acesso Design

O painel existente em `/admin.html` possui uma área de produtos para `design`
(edição) e `design_view` (consulta). O login principal também encaminha essas
funções para o painel. Ambos consultam o catálogo compartilhado completo,
incluindo inativos, com paginação.

Módulos: catálogo, categorias, imagens/vídeos, pesquisa de imagens, classificação,
vitrine, etiquetas e consulta de estoque. O editor altera apresentação e preço
de venda dos produtos. Quantidades de estoque, fiscal, promoções, custo, exclusão
de produtos, integrações e processos globais permanecem restritos.

O titular verificado gerencia contas existentes em **Vendedores → Acesso Design**.
Não há credenciais compartilhadas ou conta automática. Concessão, troca de modo e
revogação exigem a função atual esperada e registram auditoria na mesma transação.
Revogar retorna a função `user`; não recupera permissões administrativas antigas.

## Controle no servidor

- `designAccess.js` contém a lista explícita de métodos e caminhos autorizados.
- O middleware global consulta cargo/ativo atuais no banco, inclusive para JWT
  antigo de administrador. O cache existe somente dentro de cada requisição.
- `adminMiddleware` continua reservado à administração geral. Os módulos
  selecionados usam `productAdminMiddleware`.
- `designProductData.js` remove dados de funcionários, vendas e notas dos
  metadados legados. PUT mescla somente campos autorizados, preservando o restante.
- Consulta não gera PDF de etiquetas: o GET legado também grava metadados.
- Visitantes e sessões expiradas conservam a consulta ao catálogo público.

As funções são strings no schema existente; não exigem migração de dados.

## Verificação

Executar `node scripts/test-design-access.js`, `node scripts/test-design-products.js`
e `node scripts/test-design-ui.js`. Cobrem identidade atual, titular, concorrência,
rollback, isolamento global, montagem real Express/JWT, paginação acima de 500,
projeção de dados, payloads, consulta sem gravações e inicialização da interface.
`node scripts/test-auth-login.js` verifica a compatibilidade do login existente.

Os testes usam persistência simulada. Não criar contas, alterar permissões reais
ou usar vendas/estoque de produção como fixture.
