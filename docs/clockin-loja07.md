# Ponto da Loja 07

Investigação e correção em 31/10/2026.

## Causa

- O registro `LOJA07` estava ativo, mas com `latitude` e `longitude` nulos.
- O ponto individual (`POST /api/seller/clockin`) exigia coordenadas da loja e comparava vendedores somente com a loja principal (`storeId`). Isso impedia vendedores sem GPS configurado e vendedores que trabalham em mais de uma loja.

## Correção

- As coordenadas da Loja 07 foram preenchidas com o centro do edifício Liv Mall: `-7.09689, -34.83769`. O cadastro da loja indica Avenida Governador Flávio Ribeiro Coutinho, 500, Loja 129; o endereço oficial do Liv Mall confirma o número 500. O ponto do edifício veio do OpenStreetMap (way 679361578).
- O ponto individual passa a localizar a loja mais próxima dentre `storeId` e `storeIds` do vendedor, mantendo o raio existente de 150 m. Uma loja indicada explicitamente só é aceita quando consta no vínculo do vendedor.
- PIN, GPS, sequência das batidas, rota do ponto pelo PDV e notificação existente permanecem inalterados.

## Verificação

- A rota de lojas visível ao ponto confirmou que LOJA07 tem latitude e longitude numéricas após a atualização.
- Testes locais de seleção da loja por GPS, vínculos principal/secundário e atualização do fluxo do PDV passaram.
- Nenhuma batida de ponto de teste foi gravada.

Fontes da localização: [endereço oficial do Liv Mall](https://www.livmall.com.br/) e [mapa do edifício no OpenStreetMap via Mapcarta](https://mapcarta.com/pt/W679361578).
