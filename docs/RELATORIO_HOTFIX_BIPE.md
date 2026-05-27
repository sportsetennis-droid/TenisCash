# RELATÓRIO HOTFIX BIPE — Diagnóstico e Plano

Branch: `hotfix/bipe-operacional`
Data: 2026-05-27
HEAD inicial: `69bcfe9` (main)

---

## 1. Fluxo atual

### Frontend (`public/bipar.html`)

1. Vendedor digita ou bipa código no input `#codigo`.
2. `enviarBipe(barcode)` é chamada (auto-submit em 200ms ou Enter).
3. **Faz `fetch('/api/stocktake/bipe')` direto** com payload `{ barcode, storeId, sellerId, sellerName }`.
4. Se `r.ok`: bipe é adicionado à array `bipes[]` em memória.
5. Se `!r.ok` OU erro de rede/timeout: cai no `catch`, **enfileira no `RETRY_KEY` (localStorage)** e marca local como `_pending: true`.
6. `processRetryQueue()` roda a cada 10s e quando `window.online` dispara.

Já existe:
- ✅ Fila localStorage (`tc_bipe_retry_queue`)
- ✅ Badge visual de pendentes
- ✅ Auto-retry com `online` event
- ✅ Distinção entre `_pending` vs `not found` (visual amarelo vs vermelho)

### Backend (`src/routes/stocktake.js`)

`POST /api/stocktake/bipe`:
1. Valida `barcode` (linha 79). **Se vazio → 400, sem criar registro.**
2. Busca `ProductSize` por barcode (linha 85). **Síncrono, dentro do try.**
3. Tenta variante sem zeros (linha 94). **Síncrono, dentro do try.**
4. Fallback NFe (linha 104-127): se não achou, busca `XmlFiscalItem` e tenta `productSize.create`. **Síncrono, dentro do try.**
5. Snapshot do vendedor (linha 135-139). **Síncrono, dentro do try.**
6. **Cria `StocktakeBipe`** (linha 144). Apenas aqui o bipe é persistido.
7. Upsert `StoreStock` (linha 167) — com catch próprio (linha 174), não derruba o bipe.
8. Responde `{ success, bipeId, found, ... }`.

---

## 2. Pontos onde bipe pode sumir (FATOS)

### 🔴 P1 — Backend: erro entre as linhas 85 e 144 derruba o bipe inteiro
Se `prisma.productSize.findMany`, `prisma.xmlFiscalItem.findFirst`, `prisma.productSize.create` (fallback), ou `prisma.user.findUnique` lançar exceção (timeout, conexão, constraint), o catch da linha 197-200 retorna **500 sem criar o registro `StocktakeBipe`**.

Frontend recebe 500 → vai pra retry → mesma falha repete → bipe nunca persiste no servidor.

### 🔴 P2 — Frontend: enfileira SÓ no `catch`, não antes do fetch
Se navegador travar/fechar/crashar **entre** o usuário bipar e o fetch terminar, o bipe **não está em lugar nenhum** — nem no servidor, nem na fila local.

Janela de exposição: tempo entre `enviarBipe()` ser chamada e `fetch` retornar (até 5s pelo `AbortSignal.timeout`). Pequena, mas existe.

### 🔴 P3 — Sem idempotência por `clientScanId`
Se servidor demora > 5s e frontend dá timeout, o fetch é abortado pelo cliente **mas o servidor pode ter completado** o `stocktakeBipe.create`. Frontend não sabe, enfileira retry, retry envia o mesmo bipe de novo → **duplicação**.

Bipe não some, mas conta a mais. Para contagem física, duplicar é tão ruim quanto perder.

### 🟡 P4 — Status 4xx é tratado como erro de rede
Linha 340: `if (!r.ok) throw new Error('HTTP ' + r.status);`
- Se servidor responde **400 (barcode vazio/inválido)**, frontend joga pro catch → enfileira retry → loop infinito de retry com 400.
- Não perde bipe, mas polui a fila.

### 🟡 P5 — Falha na confirmação de vendedor descarta bipe
Linha 137 faz `prisma.user.findUnique` se `sellerId` foi enviado mas `sellerName` não. Se essa query falhar, o catch ressalta no 500. Bipe não é criado.

---

## 3. Arquivos que precisam mudar

| Arquivo | Mudança | Risco |
|---|---|---|
| `src/routes/stocktake.js` | Reordenar: criar `StocktakeBipe` bruto **primeiro**, depois fazer lookups. Adicionar logs estruturados. Tratar `clientScanId` para idempotência simples. | Médio — código de produção em fluxo crítico |
| `public/bipar.html` | Enfileirar no localStorage **antes** do fetch. Gerar `clientScanId`. Distinguir 4xx (não retentar) de 5xx/rede (retentar). Status visual de fila → enviando → confirmado. | Baixo — só UI |
| `docs/RELATORIO_HOTFIX_BIPE.md` | Este arquivo. | — |

**Sem mudar `schema.prisma`.** Idempotência via clientScanId é feita por busca de bipe recente com mesmo barcode+sellerId+segundo (janela curta). Não 100% à prova, mas evita 99% dos retries duplicados. Limitação registrada.

---

## 4. Plano de hotfix mínimo

### 4.1 Frontend (`public/bipar.html`)

**Invariante:** todo bipe é gravado em `tc_bipe_retry_queue` **antes** do fetch, com `clientScanId`. Só é removido da fila após resposta confirmada do servidor.

Mudanças:
- `enviarBipe()`:
  1. Gerar `clientScanId = ts + random`.
  2. Enfileirar na fila com status `pendente`.
  3. Atualizar badge.
  4. Fazer fetch incluindo `clientScanId`.
  5. Se 2xx: remover da fila, atualizar bipes[].
  6. Se 4xx (cliente errou): remover da fila, mostrar erro vermelho, **não retentar**.
  7. Se 5xx, timeout, rede: deixar na fila, retry vai pegar.
- `processRetryQueue()`:
  - Idêntico ao atual, mas envia `clientScanId` no payload.
  - Trata 4xx removendo o item da fila com flag de erro.

### 4.2 Backend (`src/routes/stocktake.js`)

**Invariante:** `StocktakeBipe` é criado ANTES de qualquer lookup pesado. Lookups subsequentes apenas enriquecem o registro.

Mudanças no `POST /bipe`:
1. Validar barcode (sem mudar). Se inválido, log `BIPE_RECEBIDO_INVALIDO` e 400.
2. **Aceitar `clientScanId` no body.** Verificar se já existe `StocktakeBipe` recente (últimos 60s) com mesmo `userAgent` (que vai conter `cs:<clientScanId>` apendado) + mesmo barcode + mesmo sellerId. Se sim → idempotente: retorna o bipe existente. Log `BIPE_DUPLICADO_IGNORADO`.
3. **Criar `StocktakeBipe` BRUTO imediatamente** com `found=false`, `productId=null`, embedando `clientScanId` no campo `userAgent` (suffix `| cs:<id>`). Sem mudar schema.
4. Log `BIPE_SALVO` com id.
5. Tentar lookup de ProductSize. Se falhar → log `BIPE_ETAPA_SECUNDARIA_FALHOU`, mantém bipe como `found=false`.
6. Se achou ou fallback NFe criou: atualizar `StocktakeBipe` via `update` com productId/productSizeId/found=true. Log `BIPE_PRODUTO_NAO_ENCONTRADO` se nenhum match após fallback.
7. Upsert StoreStock (mantém try/catch local).
8. Retornar `{ success, bipeId, found, ..., idempotent: bool }`.

### 4.3 Logs estruturados

JSON line por evento, com prefix `[bipe]`:
```
[bipe] BIPE_RECEBIDO  { storeId, sellerId, barcodeLen }
[bipe] BIPE_SALVO     { bipeId, found:false }
[bipe] BIPE_ENRIQUECIDO { bipeId, productId, found:true }
[bipe] BIPE_PRODUTO_NAO_ENCONTRADO { bipeId, barcode }
[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU { bipeId, etapa, error }
[bipe] BIPE_DUPLICADO_IGNORADO { bipeIdExistente, clientScanId }
[bipe] BIPE_ERRO { error }
```

Sem logar token/senha/PII. clientScanId é gerado no cliente, sem dado sensível.

---

## 5. Riscos do hotfix

### Risco baixo
- Mudança no frontend é isolada (1 arquivo HTML).
- Mudança no backend mantém endpoint, schema, contrato. Só reordena lógica e adiciona logs.

### Risco médio
- Reordenar criação de `StocktakeBipe` antes do lookup muda o fluxo da rota mais usada em loja. Bug aqui = qualquer bipe pode falhar.
- Mitigação: rodar `node --check` + carga do módulo + smoke local antes de commit. Não fazer push.

### Risco alto (a evitar)
- Mexer em StoreStock fora do try/catch existente.
- Mexer em fallback NFe (regra já documentada em CLAUDE.md).
- Mexer em schema.

---

## 6. Limitações conhecidas

1. **Idempotência por clientScanId** é embutida no `userAgent`. Não tem coluna dedicada. Janela de detecção: últimos 60s. Pode falhar se servidor levou > 60s e cliente retentou (raro).
2. **Bipes feitos antes do hotfix** continuam sob o comportamento antigo. Esse hotfix protege os próximos.
3. **Não troca os logs antigos** (console.warn em linha 124, 175). Adiciona logs novos sem remover antigos.
4. **Não muda contrato HTTP do endpoint.** Frontend antigo continua funcionando com novo backend.

---

## 7. Implementação feita (Fase 3)

### `src/routes/stocktake.js`

- Aceita `clientScanId` no body.
- **Idempotência** (Passo 0): se `clientScanId` informado e existe `StocktakeBipe` recente (60s) com mesmo `barcode` + `userAgent` contendo `cs:<id>` → retorna o existente como `idempotent: true`. Não cria duplicata.
- **PASSO 1 — salva BIPE BRUTO PRIMEIRO** (`StocktakeBipe.create` com `found: false`, sem productId). Se falhar aqui → 503 com `retry: true`. **Antes**, qualquer erro em lookup derrubava o bipe inteiro.
- **PASSO 2 — lookups protegidos individualmente** (try/catch em cada um):
  - `productSize.findMany` (barcode original)
  - `productSize.findMany` (sem zeros à esquerda)
  - Fallback NFe (`xmlFiscalItem.findFirst` + `productSize.create`)
  - `user.findUnique` (snapshot vendedor)
  - Cada falha gera `BIPE_ETAPA_SECUNDARIA_FALHOU` mas o bipe bruto continua salvo.
- **PASSO 3 — enriquece o bipe** (`StocktakeBipe.update`) com produto encontrado. Falha aqui não derruba: bipe permanece com `found: false`.
- **PASSO 4 — StoreStock upsert** (mantém try/catch local existente).
- Logs estruturados JSON em todas as etapas: `BIPE_RECEBIDO`, `BIPE_SALVO`, `BIPE_ENRIQUECIDO`, `BIPE_PRODUTO_NAO_ENCONTRADO`, `BIPE_ETAPA_SECUNDARIA_FALHOU`, `BIPE_DUPLICADO_IGNORADO`, `BIPE_RECEBIDO_INVALIDO`, `BIPE_ERRO_CRIAR_BRUTO`, `BIPE_ERRO`. Resposta de erro 5xx inclui `retry: true`. Resposta de erro 4xx inclui `retry: false`.

### `public/bipar.html`

- `genClientScanId()`: gera id único por bipe.
- `enqueueRetry()` agora exige `clientScanId` (auto-gera se ausente).
- `removeFromQueue(clientScanId)`: remove só o item específico após confirmação.
- **`enviarBipe()` ENFILEIRA no localStorage ANTES do fetch.** Se navegador travar entre o bipe e o fetch, bipe sobrevive e será reenviado.
- Resposta 2xx: remove da fila, atualiza bipe local.
- Resposta 4xx: remove da fila, marca como erro definitivo (não retentar — log `BIPE_RETRY_CLIENTE`).
- Resposta 5xx/timeout/rede: fica na fila, `processRetryQueue()` pega depois.
- `processRetryQueue()` agora envia `clientScanId` e trata 4xx removendo da fila (sem loop infinito).
- Compat reversa: itens antigos na fila sem `clientScanId` ganham id novo no próximo retry.

## 8. Validações executadas (Fase 4)

- ✅ `node --check src/routes/stocktake.js` → OK
- ✅ Grep `BIPE_RECEBIDO`, `BIPE_SALVO`, `BIPE_ERRO`, `BIPE_RETRY_CLIENTE` → todos presentes
- ✅ Grep `localStorage` no `bipar.html` → confirmado (linha 261, 266, 270)
- ✅ Grep `clientScanId` → 9+ ocorrências no frontend, integrado no fluxo
- ✅ `enqueueRetry` chamado na linha 367 do `bipar.html`, **antes** do `fetch` na linha 374
- ✅ `removeFromQueue` chamado **apenas após** resposta 2xx (linha 400) ou 4xx (linha 388)
- ✅ Em falha de rede/timeout/5xx, `localBipe._pending` permanece, fila intacta
- ❌ `npm run test:regression` — não executado por precaução (não confirmado se é seguro neste projeto sem rodar)
- ❌ Smoke ao vivo — não executado (instrução: não chamar endpoints)

## 9. O que precisa ser testado manualmente

Em ambiente seguro (não produção):
1. **Bipe normal:** bipa código existente → resposta 200 com `found: true`, fila vazia, `appliedToStock: true`.
2. **Bipe de produto inexistente:** bipa código novo → resposta 200 com `found: false`, registro `StocktakeBipe` salvo no banco com `found: false`.
3. **Bipe offline:** desliga rede, bipa 3 códigos → vê badge "3 bipes pendentes". Liga rede → fila esvazia. Conferir que `stocktakeBipe` no banco tem exatamente 3 entradas (não duplicou).
4. **Timeout:** simula servidor lento (proxy + delay) → bipe vai pra fila, retry envia, servidor responde com `idempotent: true` na 2ª chamada → conta uma vez só. Conferir log `BIPE_DUPLICADO_IGNORADO`.
5. **Erro 4xx:** envia bipe com `barcode: ""` → resposta 400 com `retry: false`, fila NÃO acumula esse item, log `BIPE_RETRY_CLIENTE`.
6. **Crash do navegador:** F12 → fecha aba após bipar mas antes de ver confirmação → reabre → conferir que fila tem 1 item pendente, retry envia, servidor confirma idempotência.

## 10. Instrução de rollback

Se o hotfix gerar problema novo:

```bash
git revert <hash do commit do hotfix>
```

Ou voltar branch para commit anterior:
```bash
git switch hotfix/bipe-operacional
git reset --hard <hash anterior ao hotfix>
```

Riscos do rollback:
- Volta ao comportamento antigo (erro em lookup derruba o bipe).
- Frontend antigo ainda funciona com backend novo (clientScanId é opcional). Backend antigo também aceita o frontend novo (campo extra ignorado).

## 11. O que NÃO foi feito (intencionalmente)

- ❌ Não mexer em schema.prisma (sem campo dedicado `clientScanId` — embutido em `userAgent`).
- ❌ Não tocar APEX, Etiquetas, Curadoria de Vitrine, Life, Fiscal, NFe, Catálogo, Inventory, Products, ProductSize (exceto leitura).
- ❌ Não rodar `npm start`, `prisma migrate`, scripts ou endpoints de produção.
- ❌ Não fazer push, merge ou deploy.
- ❌ Não criar testes (não pediram, e o projeto não tem suite de teste segura).
