# Instruções pra outra IA preencher descrições de produtos Converse

## Contexto

Você vai receber um arquivo JSON chamado `products-research.json` contendo uma lista de produtos da Converse (linha Chuck Taylor / Star Player / etc) que estão no nosso catálogo mas faltam a descrição oficial.

Para cada produto, você precisa pesquisar no site oficial `https://www.converse.com.br` e preencher 2 campos:

- `url_da_pagina_oficial` — a URL da página do produto no converse.com.br
- `descricao_html` — a descrição completa em HTML

## Como pesquisar (em ordem)

Cada produto tem um array `urls_sugeridas` com 3 caminhos de busca:

1. **Busca interna do site** — `https://www.converse.com.br/catalogsearch/result/?q=CK12410002` (substitua pelo `referencia`)
2. **Google site:converse.com.br por referência** — `site:converse.com.br "CK12410002"`
3. **Google site:converse.com.br por nome** — `site:converse.com.br Converse Chuck Taylor All Star ...`

Tente os 3 caminhos. Se nenhum encontrar, use o campo `observacao` pra registrar (ex: "não encontrado no site oficial").

## Formato da `descricao_html`

A descrição na página oficial da Converse normalmente tem essa estrutura:

```html
<h2>ÍCONE DO DIA A DIA.</h2>
<p>Deixe sua personalidade brilhar com esses clássicos All Stars! E já que seu estilo evolui, que tal um par em cada cor para acompanhar todas as suas fases?</p>
<h2>Características e benefícios</h2>
<ul>
<li>Cabedal em lona de algodão.</li>
<li>Forro em poliéster.</li>
<li>Silhueta clássica com biqueira de borracha.</li>
<li>Placa traseira Converse All Star que celebra o legado da marca.</li>
<li>Cadarços em poliéster.</li>
<li>Solado de borracha com padrão de diamante.</li>
</ul>
<h2>Origem do Chuck Taylor All Star</h2>
<p>Criado em 1917 como um tênis de basquete que não escorregava, o All Star foi originalmente promovido pela performance do jogador Chuck Taylor. ...</p>
```

**Mantenha as tags:** `<h2>`, `<p>`, `<ul>`, `<li>`, `<strong>`, `<em>`, `<br>`.
**Remova:** `<style>`, `<script>`, `data-*`, `class=""`, `<div>` vazios, `<span>` sem propósito.

## Regras importantes

- **Idioma:** mantenha o texto em **português** exatamente como está no site oficial.
- **Não invente descrição.** Se não achar a página, deixe `descricao_html` vazio e marque na `observacao`.
- **Cores acentuadas:** `ê`, `ç`, `ã`, `õ` — escape no JSON usando UTF-8 nativo (`"ção"` está OK em JSON).
- **Aspas dentro de aspas:** escape `"` interno como `\"`.
- **Quebras de linha:** dentro do HTML use `<br>` ou estrutura com `<p>`. **Não use `\n` literal**.

## Exemplo de linha preenchida

```json
{
  "id": "1732251a-089c-48dc-9c95-718df891f7f4",
  "sku": "0750-7895491366024",
  "referencia": "CK12410002",
  "nome": "Tênis Converse Chuck Taylor All Star 1V Frutas Silvestres/Amêndoa/Preto",
  "marca": "Converse",
  "cor": "Frutas Silvestres/Amêndoa/Preto",
  "url_da_pagina_oficial": "https://www.converse.com.br/chuck-taylor-all-star-1v-frutas-silvestres-amendoa-preto-ck12410002",
  "descricao_html": "<h2>ÍCONE DO DIA A DIA.</h2><p>Texto completo...</p><h2>Características e benefícios</h2><ul><li>Cabedal em lona de algodão.</li>...</ul>",
  "observacao": ""
}
```

## Entrega

Devolva o **JSON inteiro** preenchido, com os mesmos `id` e demais campos preservados. Só `url_da_pagina_oficial`, `descricao_html` e `observacao` mudam.

O arquivo será importado de volta pelo script `scripts/import-descriptions-from-json.js`.
