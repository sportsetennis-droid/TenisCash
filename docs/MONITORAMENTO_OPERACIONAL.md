# MONITORAMENTO OPERACIONAL — TenisCash

Documento de rotina de monitoramento da operação em produção. Cobre logs críticos, sinais de alerta e rotina de checagem.

Data: 2026-05-27
Status: **DIAGNÓSTICO + ROTINA MANUAL** — alertas automáticos ainda não configurados.

---

## 1. Situação atual encontrada

### O que existe

| Item | Status |
|---|---|
| Endpoint `/api/health` | ✅ existe (`src/index.js:156`) — retorna 200 com `{status:"ok"}` |
| Healthcheck do Railway | ✅ configurado em `railway.toml` apontando pra `/api/health` |
| Logs estruturados `[bipe] BIPE_*` | ✅ implementados no hotfix (17 pontos em `src/routes/stocktake.js`) |
| `src/services/slackNotifier.js` | ⚠️ arquivo existe mas **NÃO É USADO** em nenhum lugar (código morto) |
| Logs estruturados em outros serviços críticos | ❌ não-estruturados (apenas `console.error('[modulo]', err)`) |
| Sentry / observability tool | ❌ não configurado |
| Alerta por e-mail em erro 500 | ❌ não existe |
| Webhook Slack disparado por logs críticos | ❌ não existe (apesar de existir o módulo `slackNotifier.js`) |
| Dashboard de saúde por loja | ❌ não existe |

### Resumo

O único monitoramento automático é o healthcheck do Railway. Logs de bipe são estruturados, mas só viram alerta se alguém ler os logs no painel Railway manualmente. Tudo o mais é reativo (alguém só descobre que tem problema quando reclama).

---

## 2. Logs críticos a monitorar

### 2.1 Bipe (hotfix recente, 27/05/2026)

| Log | Severidade | Significado | Frequência esperada |
|---|---|---|---|
| `[bipe] BIPE_RECEBIDO` | info | Servidor recebeu requisição válida | 1 por bipe físico |
| `[bipe] BIPE_SALVO` | info | `StocktakeBipe.create` concluído (garantia mínima) | 1 por bipe — **SEMPRE deve aparecer após RECEBIDO** |
| `[bipe] BIPE_ENRIQUECIDO` | info | Bipe atualizado com produto encontrado | 1 quando produto existe |
| `[bipe] BIPE_PRODUTO_NAO_ENCONTRADO` | info | Barcode não está em ProductSize nem XmlFiscalItem | esperado em bipes de produto cru |
| `[bipe] BIPE_AUTOCRIOU_PRODUCTSIZE` | info | Fallback NFe criou ProductSize automaticamente | esperado quando NFe entrada chegou antes do cadastro manual |
| `[bipe] BIPE_DUPLICADO_IGNORADO` | info | Mesmo `clientScanId` chegou 2x dentro de 60s | esperado em retry após timeout |
| `[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU` | aviso | Falha em lookup/enriquecimento/upsert | aceitável esporádico; preocupante em massa |
| `[bipe] BIPE_RECEBIDO_INVALIDO` | aviso | barcode vazio/ausente | aceitável esporádico (clique sem código) |
| `[bipe] BIPE_ERRO_CRIAR_BRUTO` | 🔴 grave | Bipe bruto não conseguiu ser persistido — bipe **NÃO salvo** | nunca deveria acontecer; investigar imediatamente |
| `[bipe] BIPE_ERRO` | 🔴 grave | Erro genérico inesperado no fluxo | nunca; investigar |

### 2.2 Health endpoint

```
GET https://teniscash.com.br/api/health
```

Resposta esperada:
```json
{"status":"ok","service":"TenisCash API","version":"1.0.0"}
```

Se NÃO retornar 200 OU não retornar esse JSON: servidor caído ou rota quebrada.

### 2.3 Logs fiscais a mapear futuramente

Hoje não estruturados. **A mapear no ciclo de Fiscal** (fora deste ciclo):
- `[fiscalDraftJob]` — usado em `console.error(...)` no `src/services/fiscalDraftJob.js`
- Logs do `import-nfe-zip-2025.js`
- Logs do `xmlImport.js` (rota)
- Logs do `fiscalSefazDirect.mjs`

Recomendação futura: trocar para padrão `[fiscal] FISCAL_<EVENTO>` igual ao `[bipe]`.

### 2.4 Logs de catálogo a mapear futuramente

- `adminCatalog.js` — sem padrão estruturado.
- `aiCuration.js` — log de cada produto curado, mas sem padrão.
- `products.js` — sem log relevante.

Recomendação futura: mapear no ciclo de Catálogo.

### 2.5 Logs de crons

- `[fiscalDraftJob] erro draft ...` — quando processamento de NFe rascunho falha
- `[fiscalDraftJob] erro geral: ...` — falha geral do cron
- `[marketingCron] trend-watcher erro: ...` — falha no trend watcher
- `[messagesCron] ...` — não auditado

Recomendação: padronizar prefix `[cron]` com nome do job.

---

## 3. Sinais de alerta

### 🔴 Crítico — agir imediatamente

| Sinal | Como detectar | Ação imediata |
|---|---|---|
| **Aumento de erro 500 em qualquer endpoint** | Logs do Railway com stack trace + frequência crescente | Investigar stack trace, considerar rollback |
| **`BIPE_ERRO_CRIAR_BRUTO` aparecendo** | Grep `BIPE_ERRO_CRIAR_BRUTO` nos logs | Bipe não está sendo salvo. Investigar conexão com banco, pool exausto |
| **`BIPE_RECEBIDO` SEM `BIPE_SALVO` correspondente** | Contagem nos logs (RECEBIDO > SALVO) | Bipes estão sendo perdidos. Mesmo problema do incidente de 26/05 |
| **Loop de restart** | Railway dashboard mostra container reiniciando ≥ 3x em 5 min | Última deploy quebrou algo. Considerar rollback |
| **Falha de deploy** | Railway notifica deploy failure | Build/start falhou. Conferir logs |
| **`Cannot connect to database`** | Logs com erro de Prisma | Banco caído OU `DATABASE_URL` quebrada |
| **`/api/health` retorna != 200** | curl externo | Servidor inacessível |

### 🟡 Atenção — agir em 24h

| Sinal | Como detectar |
|---|---|
| **`BIPE_ETAPA_SECUNDARIA_FALHOU` em volume crescente** | Comparar contagem nos logs entre dias |
| **`BIPE_PRODUTO_NAO_ENCONTRADO` > 30% dos bipes** | Indica catálogo defasado ou NFes não importadas |
| **Cron disparando fora do horário esperado** | Logs com timestamp UTC sem timezone (regra `America/Fortaleza` violada) |
| **Tempo de resposta > 3s em endpoints normais** | Sem APM hoje — sentir pela UX dos vendedores |

### 🟢 Saudável — comportamento esperado

- `BIPE_RECEBIDO` e `BIPE_SALVO` em proporção 1:1
- `BIPE_ETAPA_SECUNDARIA_FALHOU` esporádico (1-5 por dia, OK)
- `/api/health` 200 estável
- Deploys Railway success em < 3 min

---

## 4. Rotina de checagem

### 4.1 Após cada deploy (obrigatório)

1. Verificar painel Railway: deploy status = `success`.
2. `curl https://teniscash.com.br/api/health` → esperado 200.
3. Olhar últimas 50 linhas do log: sem erro 500.
4. Pedir a 1 loja pra bipar 1 item → confirmar com vendedor que funcionou.

### 4.2 Abertura da loja (manhã, 08:00 PB)

1. Dono ou gerente abre `https://teniscash.com.br/api/health` → 200.
2. Abre `/bipar.html` → carrega normal.
3. Confere com vendedor de 1 loja se sistema responde rápido.

Se algum item falhar: avisar dono antes da loja começar a operar.

### 4.3 Fechamento da loja (noite, 22:00 PB)

1. Comparar contagem do dia:
   - `GET /api/stocktake/summary` (autenticado) ou aba "Bipes" no admin
   - Total bipado vs esperado (estimativa).
2. Se contagem de erro `not_found` > 30% do total do dia: anotar pra revisar catálogo no dia seguinte.
3. Conferir que backup automático rodou (Railway ou cron local — quando estiver implementado).

---

## 5. Próximos passos para alertas automáticos

Em ordem de prioridade:

### Curto prazo (próximo ciclo de operação)
1. **Ativar `slackNotifier.js`** que já existe mas está sem uso. Configurar webhook no Slack do dono.
2. **Disparar Slack** quando logs `BIPE_ERRO_CRIAR_BRUTO` ou `BIPE_ERRO` aparecerem.
3. **Disparar Slack** quando deploy Railway falhar.

### Médio prazo
1. Implementar Sentry (free tier) ou similar pra capturar exceptions estruturadamente.
2. Construir dashboard `/admin#saude` mostrando:
   - Bipes hoje por loja (RECEBIDO vs SALVO)
   - Erros 5xx últimos 24h
   - Crons executados nas últimas 24h
   - Tempo médio de resposta dos endpoints críticos

### Longo prazo
1. Alerta por e-mail/SMS pra dono em sinais críticos.
2. APM (Datadog, New Relic, ou similar) — opcional, custo a avaliar.
3. Logs centralizados (BetterStack, Logtail) — opcional.

**NÃO criar essas automações neste ciclo.** Este documento é orientação; implementação é tarefa separada com seu próprio plano.

---

## 6. Acesso rápido pra dono

| Recurso | Link / Comando |
|---|---|
| Health check | https://teniscash.com.br/api/health |
| Painel Railway | https://railway.com/project/2c18736a-c03a-44b8-be0d-fa3a6851619e |
| Logs Railway | painel Railway → serviço → Deployments → último → View Logs |
| Tela de bipe | https://teniscash.com.br/bipar.html |
| Admin | https://teniscash.com.br/admin.html |
| Resumo do dia | `GET /api/stocktake/summary` (autenticado) |

---

## 7. Atestado deste documento

Este documento é **operacional e descritivo**. Não cria nenhum cron, alerta ou automação. Só descreve o que existe hoje e o que recomenda para o futuro.

Para qualquer implementação de alerta automático: plano dedicado + revisão humana antes do merge.
