# Módulo Curadoria de Vitrine

> Módulo extraído em 26/05/2026. Curadoria física de vitrine de loja: zonas, items, checklist de tarefas, fotos antes/depois, resultado consolidado.

## Objetivo

Agrupar em um bounded context isolado o código backend da **Curadoria de Vitrine** — ferramenta operacional para o gerente da loja física montar a exposição visual (vitrine, manequim, prateleiras), registrar itens curados, marcar tarefas, subir fotos antes/depois e fechar o resultado.

## Arquivo movido

| De | Para |
|---|---|
| `src/routes/curation.js` (362 linhas) | `src/modules/curadoria-vitrine/routes/curation.js` |

**Não há service auxiliar.** Toda a lógica do módulo vive no próprio route handler (diferente de APEX e Etiquetas).

## Mount público que DEVE permanecer literalmente igual

```
app.use('/api/admin/curation', curationRoutes);
```

Localizado em `src/index.js` linha 124. Esta string **não pode mudar** durante esta extração nem em refators futuros sem coordenação com `public/admin.html` (que consome via `fetch()`).

## Módulo IRMÃO proibido (NÃO TOCAR)

Existe outro módulo com nome parecido — `Curadoria de Produto IA` — que **não é este**:

| Item | Curadoria de Vitrine (este módulo) | Curadoria de Produto IA (proibido) |
|---|---|---|
| Route | `src/modules/curadoria-vitrine/routes/curation.js` | `src/routes/aiCuration.js` |
| Service auxiliar | (nenhum) | `src/services/curationAgent.js` |
| Mount público | `/api/admin/curation` | `/api/admin/ai-curation` |
| Modelos | `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult` | `Product.aiContext`, `ProductCreative` |
| Uso em produção | 0 (tabelas vazias) | 6.170 produtos curados de 7.093 |
| Risco | 🟢 BAIXÍSSIMO | 🔥 ALTO |

**Arquivos proibidos** que ninguém pode tocar como parte de mudanças neste módulo:
- `src/routes/aiCuration.js`
- `src/services/curationAgent.js`
- `scripts/run-curation-all.js` (consumidor de `curationAgent`)
- Qualquer endpoint `/api/admin/ai-curation/...`
- `Product.aiContext` e qualquer derivado

## Dependências

- `express` (npm)
- `../../../middleware` → `src/middleware.js` (traz `authMiddleware`, `adminMiddleware`, `prisma`)
- Modelos Prisma `StoreCuration*` (continuam em `prisma/schema.prisma`, schema único)
- Leitura cruzada de `Product` apenas no endpoint `GET /:id/suggestions` (read-only)

**Zero integração externa:** sem Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Web Push, Slack, SEFAZ. Sem `pdfkit`, sem `qrcode`. Sem cron. Sem geração de PDF.

## Estado das tabelas

Todas as 6 tabelas `StoreCuration*` estão **vazias** em produção. Mexer neste módulo não afeta nenhuma operação real das lojas (confirmado em `docs/MAPA_ATUAL.md`).

## Referências

- **Plano de extração:** [`docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md`](../../../docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md)
- **Baseline pré-extração:** [`docs/BASELINE_PRE_EXTRACAO_CURADORIA_VITRINE.md`](../../../docs/BASELINE_PRE_EXTRACAO_CURADORIA_VITRINE.md)
- **Regras críticas do projeto:** [`docs/REGRAS_CRITICAS.md`](../../../docs/REGRAS_CRITICAS.md)
- **Checklist de regressão:** [`docs/REGRESSION_CHECKLIST.md`](../../../docs/REGRESSION_CHECKLIST.md)
- **Padrão de extração precedente:** APEX e Etiquetas, ver respectivos READMEs em `src/modules/apex/` e `src/modules/labels/`.
