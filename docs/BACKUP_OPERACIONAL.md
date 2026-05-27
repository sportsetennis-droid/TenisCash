# BACKUP OPERACIONAL — TenisCash

Documento vinculante de rotina de backup do banco TenisCash.

Data: 2026-05-27
Status: **DIAGNÓSTICO + PROPOSTA** — rotina ainda não automatizada.

---

## 1. Situação atual encontrada

### Onde fica o backup

| Local | Status |
|---|---|
| Pasta `backups/` no repositório local | ✓ existe |
| `backups/` no `.gitignore` (linha 16) | ✓ não vai pro Git |
| Backups no Railway (painel) | ❓ **status desconhecido** — precisa o dono confirmar manualmente no painel Railway |
| Cron de backup no servidor | ❌ **não existe** |
| Script de backup em `scripts/` | ❌ **não existe** (só `export-products-for-research.js` e `export-whatsapp-not-found.js` — exports focados, não backup geral) |

### Backup mais recente local

```
backups/db-2026-05-26T22-36-09/
├── brandProfile.json          6 KB
├── campaign.json              vazio
├── categoryNode.json         31 KB
├── config.json               vapid keys + welcome_bonus
├── fiscalDocument.json       20 KB
├── fiscalIssuer.json          4 KB
├── partner.json              vazio
├── partnerSale.json          vazio
├── product.json              15.9 MB  ← grosso
├── productCreative.json     133 KB
├── productLifecycle.json     vazio
├── productSize.json          1.6 MB
└── (+ 11 outros json)
```

Total: **23 arquivos JSON**, ~30 MB. Criado em **26/05/2026 22:36** (no contexto da emergência dos bipes perdidos).

### Limitações do backup atual

1. ⚠️ **Só 23 das 114 tabelas Prisma** foram exportadas. Está faltando: `StocktakeBipe`, `StoreStock`, `XmlFiscalItem`, `XmlFiscalDocument`, `Transaction`, `Wallet*`, `User`, `Store`, `LabelBatch`, `Sale*`, `Activity*` (APEX), `Curation*` e mais ~80 tabelas.
2. ⚠️ Formato **JSON Prisma-export** — não é `pg_dump`. Restore exige código Prisma + ordem de inserção respeitando FK.
3. ⚠️ Backup foi criado **manualmente uma única vez** em 26/05. Sem rotina.
4. ⚠️ **Não foi testado restore** desse backup. Backup sem teste de restore = esperança, não backup.

### Backups manuais recentes (não relacionados a backup geral)

```
_backup_loja04_2026-05-27T15-06-27.json           41 KB   (12 bipes da LOJA04 apagados)
_backup_stocktakeBipe_2026-05-27T15-00-51.json     1.97 MB (2.846 bipes ≤ 26/05 apagados)
```

Esses são exports cirúrgicos do hotfix de bipe — não cobrem todo o banco.

### Railway nativo

Railway oferece backup automático do Postgres no painel web (não acessível via CLI sem login interativo). **Status atual: NÃO CONFIRMADO.** O dono precisa abrir o painel Railway → Postgres → Backups e confirmar se está ligado.

---

## 2. Risco atual

### 🔴 Alto

- Se o banco Railway corromper agora, o backup local de 26/05 só restaura ~20% das tabelas.
- Bipes do dia 27 em diante (após o backup) **não estão em backup nenhum**. Perda total se algo der errado.
- Sem teste de restore documentado, nem o backup parcial existente está garantido.

### 🟡 Médio

- `railway.toml` tem `startCommand = "npx prisma db push && ..."` — toda deploy roda `db push`. Se uma mudança de schema for empurrada acidentalmente, pode haver perda de dados sem rollback fácil.
- Sem rotação de retenção: 1 backup só. Se ele corromper, fim.

---

## 3. Como identificar o backup mais recente

```bash
ls -t backups/ | head -3
```

Convenção de nome usada: `db-<ISO-timestamp>` (ex: `db-2026-05-26T22-36-09`).

Cada pasta contém arquivos `<tabela>.json` com o conteúdo exportado da respectiva tabela Prisma na data.

---

## 4. Recomendação de rotina diária

### Fase imediata (sem código novo, manual)

**Toda noite às 22:00 (horário de PB), antes do fechamento das lojas:**

1. Abrir painel Railway → Postgres → Backups → confirmar que o backup automático nativo está ligado.
2. Se NÃO estiver ligado: ligar agora. Custo: incluído no plano Pro do Railway, geralmente.
3. Se backup nativo Railway estiver inviável: usar `pg_dump` via Railway CLI (autenticado) ou via `DATABASE_URL` local:
   ```bash
   pg_dump "$DATABASE_URL" > backups/db-$(date -u +%Y-%m-%dT%H-%M-%S).sql
   ```
   Isso gera um SQL completo (todas as 114 tabelas) que pode ser restaurado com `psql`.

### Fase futura (automatizada, fora deste ciclo)

- Cron diário (`America/Fortaleza` 03:00) rodando `pg_dump` para um bucket S3 / Backblaze / Drive.
- Cron semanal arquivando o último backup diário em pasta semanal.
- Cron mensal arquivando o último semanal em pasta mensal.
- **NÃO criar esse cron neste ciclo** — exige plano dedicado, decisão de provedor de armazenamento e teste de restore antes.

---

## 5. Recomendação de retenção

| Tipo | Frequência | Retenção | Onde |
|---|---|---|---|
| **Diário** | Todo dia 22:00 PB | **30 dias** | Local ou bucket cloud |
| **Semanal** | Domingo 22:00 PB | **12 semanas** | Bucket cloud |
| **Mensal** | Dia 1 do mês 22:00 PB | **12 meses** | Bucket cloud (storage frio se quiser barato) |

**Total no pior caso:** 30 + 12 + 12 = **54 backups** mantidos. Para um banco de ~30 MB, isso é ~1.6 GB. Trivial.

---

## 6. O que NÃO fazer

- ❌ **NÃO** apagar backups existentes sem confirmar que existem mais recentes E testados.
- ❌ **NÃO** confiar em backup que nunca foi restaurado em ambiente de teste.
- ❌ **NÃO** rodar `pg_dump` diretamente em produção sem ter um banco staging pra testar restore antes.
- ❌ **NÃO** commitar backups no Git (`backups/` está no `.gitignore` por isso).
- ❌ **NÃO** rodar `npx prisma db push --force-reset` em produção — destrói tudo.
- ❌ **NÃO** rodar `npx prisma migrate reset` em produção.
- ❌ **NÃO** dar permissão de DELETE em massa pro usuário do banco Railway pra qualquer um.

---

## 7. Próximos passos antes de automatizar

1. **Dono confirmar no painel Railway** se backup automático está ligado. Status atual: desconhecido.
2. Se não estiver: ligar e definir retenção.
3. Fazer **1 teste de restore** em ambiente staging (criar staging primeiro — não existe hoje).
4. Documentar o procedimento exato de restore no `docs/RESTORE_CHECKLIST.md`.
5. **Só depois**: automatizar cron diário.

Sem completar esses 5 passos, o sistema continua em risco real de perda de dados.
