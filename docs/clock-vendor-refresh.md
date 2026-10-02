# Atualização da tela de ponto da loja

Ao trocar de loja ou de vendedor, respostas de consultas anteriores não podem substituir a lista, os botões ou o histórico da seleção atual. A tela deve limpar o estado anterior e verificar loja, sessão e ordem das requisições antes de exibir a resposta.

O botão de atualização permite recarregar a lista e o ponto do dia. Atualizações na mesma seleção preservam a senha em digitação; a troca de vendedor, loja ou conta limpa essa senha. Falhas de consulta devem aparecer na tela, sem manter ações de um estado antigo.

A volta à aba e a mudança de dia atualizam as informações. O dia de referência do ponto segue o horário de Recife, como no servidor. Atualizações automáticas não interferem em uma tentativa de registro em andamento por GPS. A tentativa usa a loja e o vendedor escolhidos no início e não pode continuar se essa seleção ou sessão mudar antes do envio.

## Verificação

Executar `node scripts/test-loja-clock-refresh.cjs` e `node scripts/test-loja-login.js`. Testes usam consultas simuladas e funções reais da página, sem bater ponto de funcionários em produção. Verificar também a lista e o histórico reais pelo navegador depois da publicação.

Os registros de dias anteriores continuam separados pelo servidor. Uma correção visual ou atualização da lista não cria entrada, retorno de intervalo nem saída retroativa.
