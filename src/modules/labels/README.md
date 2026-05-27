# Módulo Etiquetas — esqueleto

> Estrutura vazia. Nenhum arquivo do código atual foi movido. Esta pasta existe apenas como **destino futuro** da extração planejada em `docs/PLANO_EXTRACAO_ETIQUETAS.md`.

## 1. Objetivo do módulo Etiquetas

Agrupar em um único bounded context o código backend responsável pela emissão de **etiquetas de produto** da rede Sports & Tennis:

- Templates de etiqueta (A4 5×13, 3×10, 2×5, 2×2; térmica 40×30, 50×30, 60×40, 100×50; layout S&T 130mm × 14–27mm com fundo laranja `#E5571E` + QR code).
- Lotes de etiquetas (LabelBatch) gerados a partir de produtos/inventário.
- Geração de PDF via `pdfkit` + `qrcode`.
- Registro de impressões (LabelPrintLog).

A escolha de Etiquetas como **segundo módulo a ser extraído** segue o padrão validado em APEX:

- Apenas 2 arquivos backend (1 route + 1 service), 734 linhas no total.
- Zero cron, zero integração de rede externa (Anthropic, fal.ai, etc.).
- Apenas 2 importadores globais (`src/index.js:23` e `src/routes/labels.js:7`).
- Mount point único e estável: `/api/admin/labels`.

## 2. Arquivos que serão movidos futuramente

Quando a execução real for autorizada (ainda não foi), os arquivos abaixo devem migrar para esta pasta com `git mv`:

| De (hoje) | Para (futuro) |
|---|---|
| `src/routes/labels.js` | `src/modules/labels/routes/labels.js` |
| `src/services/labelGenerator.js` | `src/modules/labels/services/labelGenerator.js` |

Tamanhos (baseline):
- `labels.js` — 301 linhas
- `labelGenerator.js` — 433 linhas

Total estimado: **~734 linhas de JS** a serem reposicionadas em 2 commits atômicos.

## 3. Paths finais planejados

```
src/modules/labels/
├── README.md                          ← este arquivo (já existe, vazio de código)
├── routes/
│   └── labels.js                      ← destino futuro de src/routes/labels.js
└── services/
    └── labelGenerator.js              ← destino futuro de src/services/labelGenerator.js
```

## 4. Mount point que deve permanecer idêntico

```
app.use('/api/admin/labels', labelsRoutes);
```

Localizado em `src/index.js` linha 122. Esta string **não pode mudar** durante a extração. O frontend `public/admin.html` (aba Etiquetas) consome a API exclusivamente por esse path via `fetch()` — alterar quebra a UI silenciosamente.

Endpoints públicos inalterados (8 no total):

- `GET    /api/admin/labels/templates`
- `POST   /api/admin/labels/batches`
- `GET    /api/admin/labels/batches`
- `GET    /api/admin/labels/batches/:id`
- `GET    /api/admin/labels/batches/:id/pdf`
- `POST   /api/admin/labels/batches/:id/print`
- `DELETE /api/admin/labels/batches/:id`
- `POST   /api/admin/labels/batches/quick`

**Renomear path, mudar método HTTP ou alterar shape de payload está proibido nesta extração.**

## 5. Restrições

- **`prisma/schema.prisma` não é tocado.** Os 4 modelos `Label*` (`LabelTemplate`, `LabelBatch`, `LabelItem`, `LabelPrintLog`) entre as linhas ~903 e ~995 permanecem onde estão. Separação de schema fica para trabalho futuro com plano próprio.
- **`src/middleware.js` não é tocado.** Continua exportando `authMiddleware`, `adminMiddleware` e `prisma` instance. Os imports a partir do arquivo movido sobem 3 níveis (`../../../middleware`).
- **`public/admin.html` não é tocado.** Aba Etiquetas continua chamando o backend exclusivamente via fetch HTTP. Contrato preservado.
- **Comportamento dos endpoints não muda.** Inclusive os "GETs que escrevem" — eles continuam escrevendo (refator semântico fica fora desta extração).
- **Durante validação técnica, nenhum endpoint é chamado.** Apenas `node --check` + `node -e "require(...)"`.
- **`package.json`, `.env`, `.gitignore`, `scripts/`, demais routes/services** — intocados.

## 6. Dependências

### npm (externas, locais — sem network)
- `pdfkit` (`^0.15.2`) — geração de PDF.
- `qrcode` (`^1.5.4`) — geração de QR code.
- `buffer` — Node built-in.

### Internas
- `express` — framework Web compartilhado.
- `authMiddleware` + `adminMiddleware` — proteção de auth + role admin.
- **`prisma` (instância compartilhada)** — exportada de `src/middleware.js`. **NÃO** instanciada localmente com `new PrismaClient()`. Isto difere do APEX `activities.js`.

### Cross-domain
- Leitura da tabela `Product` (do módulo `catalogo`) — usada em `GET /batches/:id/pdf` e `POST /batches/quick` para enriquecer itens com nome, marca, preço, `aiContext.supplierRef`, classificação. Dependência de **dado**, não de código.

## 7. Observação importante (anomalias operacionais conhecidas)

⚠️ O módulo Etiquetas tem **6 dos 8 endpoints que escrevem no banco**, incluindo dois métodos `GET`:

- **`GET /api/admin/labels/templates`** — chama `ensureDefaultTemplates()` que **cria/atualiza `LabelTemplate`s** se faltarem ou se o layout S&T não bater. Idempotente em chamadas subsequentes, mas escreve na primeira chamada.
- **`GET /api/admin/labels/batches/:id/pdf`** — após gerar o PDF, atualiza `LabelBatch.status` para `'GENERATED'`. Cada GET muda estado.

Implicações:

- **Smoke test técnico não deve chamar endpoints nesta fase.** Validação se restringe a `node --check` + `node -e "require(...)"` para confirmar que módulos carregam após o `git mv`.
- **Smoke test funcional via HTTP** (gerar 1 PDF de teste em staging) só pode acontecer **após autorização explícita do dono** e em ambiente de staging — nunca em produção como parte da validação da extração.
- O refator semântico (transformar GETs-que-escrevem em POSTs) **não pertence** a esta extração. Fica registrado para ciclo futuro.

## 8. Referências

- **Plano completo de extração:** [`docs/PLANO_EXTRACAO_ETIQUETAS.md`](../../../docs/PLANO_EXTRACAO_ETIQUETAS.md)
- **Baseline pré-extração (estado capturado em 26/05/2026 no commit `c58f154`):** [`docs/BASELINE_PRE_EXTRACAO_ETIQUETAS.md`](../../../docs/BASELINE_PRE_EXTRACAO_ETIQUETAS.md)
- **Checklist de regressão obrigatório:** [`docs/REGRESSION_CHECKLIST.md`](../../../docs/REGRESSION_CHECKLIST.md)
- **Regras críticas do projeto (vinculantes):** [`docs/REGRAS_CRITICAS.md`](../../../docs/REGRAS_CRITICAS.md)
- **Padrão de extração validado:** módulo APEX, concluído em 26/05/2026 — ver [`docs/PLANO_EXTRACAO_APEX.md`](../../../docs/PLANO_EXTRACAO_APEX.md) e [`src/modules/apex/README.md`](../apex/README.md).

---

**Estado atual desta pasta:** apenas estrutura vazia + este README. Nenhum código foi movido para cá. Nenhum import foi alterado. Nenhum endpoint foi tocado. Execução real da extração depende de autorização explícita do dono.
