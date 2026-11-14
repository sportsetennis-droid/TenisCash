---
name: import-nfe-supplier
description: Importa NF-es XML de um fornecedor pro catálogo TenisCash. Cria produtos, salva custo, extrai referência (cProd), define localização Fábrica. Use quando o usuário pedir "importa o fornecedor X" ou "importar NFE da empresa Y" ou mencionar processar XMLs de uma pasta.
---

# Importar NF-es de um fornecedor

## Quando usar

- Usuário pede pra **importar produtos via NF-e** de um fornecedor novo
- Usuário menciona pasta com XMLs (`C:/Users/sport/Downloads/nfe-analysis` é o padrão)
- Usuário fala "importar fornecedor X" com nome OU CNPJ

## Passos

### 1. Identificar o CNPJ

Se o usuário deu só o nome, procura no banco:
```bash
node -e "
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.supplier.findMany({ where: { companyName: { contains: 'NOME', mode: 'insensitive' } } })
  .then(s => console.log(s)).then(()=>p.\$disconnect());
"
```

Ou lista os fornecedores disponíveis nos XMLs:
```bash
node scripts/import-all-remaining-suppliers.js  # primeiro lista, depois importa
```

### 2. Verificar se já foi importado

```bash
node -e "
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.product.count({ where: { active: true, aiContext: { path: ['supplierCnpj'], equals: 'CNPJ_AQUI' } } })
  .then(n => console.log('Já tem', n, 'produtos importados desse CNPJ')).then(()=>p.\$disconnect());
"
```

### 3. Executar import

```bash
node scripts/import-supplier.js <CNPJ_14_DIGITOS> "C:/Users/sport/Downloads/nfe-analysis"
```

O script faz:
- Lê XMLs filtrados pelo CNPJ
- Extrai brand/cor/tamanho via regex (sem IA local) OU IA (se ANTHROPIC_API_KEY)
- Agrupa variantes por base
- Cria Product + ProductSizes
- Salva custo médio em `costPrice`
- Extrai referência (cProd ou padrão "REF: XYZ" do nome)

### 4. Pós-import (opcional, perguntar ao usuário)

- **Markup**: NÃO aplicar sem confirmar com o usuário ("qual % de markup?")
- **Localização**: setar `aiContext.location = "Fábrica"`:
  ```bash
  node -e "
  const {PrismaClient} = require('@prisma/client');
  const p = new PrismaClient();
  (async () => {
    const products = await p.product.findMany({ where: { active: true, aiContext: { path: ['supplierCnpj'], equals: 'CNPJ' } } });
    for (const pr of products) {
      const ctx = typeof pr.aiContext === 'string' ? JSON.parse(pr.aiContext) : (pr.aiContext || {});
      if (!ctx.location) { ctx.location = 'Fábrica'; await p.product.update({ where: { id: pr.id }, data: { aiContext: ctx } }); }
    }
    await p.\$disconnect();
  })();
  "
  ```
- **Marca/site oficial**: atualizar `src/services/supplierOfficialSites.js` se for marca conhecida
- **Backfill ref**: rodar `node scripts/backfill-supplier-ref.js --cnpj=CNPJ` se algumas refs não foram extraídas

## Saídas esperadas

Após import bem-sucedido:
- N produtos criados (mostrar o número exato no console)
- X unidades em estoque somadas
- Custo médio R$ Y aplicado
- Próximos passos sugeridos: definir markup e rodar agente curador
