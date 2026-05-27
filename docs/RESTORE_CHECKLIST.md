# RESTORE CHECKLIST — TenisCash

Checklist obrigatório antes de restaurar qualquer backup. Procedimento exige **autorização humana explícita** em cada etapa.

Data: 2026-05-27

---

## ⛔ Regra fundamental

**Restore direto em produção é PROIBIDO sem autorização explícita do dono em conversa** + execução das etapas deste checklist.

Restore errado = perda de dado em produção. Faça em ambiente staging primeiro. Sempre.

---

## 1. Pré-condições para restore

Antes de tocar em qualquer botão, confirmar:

- [ ] Existe **backup recente** (≤ 24h) e validado (passou pelo checklist de validação abaixo).
- [ ] Existe **ambiente staging** separado do banco de produção. Hoje (27/05) ainda não há staging — precisa criar antes de restore.
- [ ] O motivo do restore foi **documentado** (incidente, perda de dado, corrupção, etc.) em mensagem ao dono ou em ticket.
- [ ] O dono autorizou explicitamente o restore (não autorização passada — autorização da janela atual).
- [ ] Foi feito **snapshot do estado atual** antes do restore (caso o restore piore as coisas, dá pra voltar).
- [ ] Janela de manutenção foi comunicada às lojas (vendedores podem perder bipes feitos durante o restore).
- [ ] Não há cron rodando no momento (`marketingCron`, `messagesCron`, `fiscalDraftJob`).

Se qualquer item falhar: **NÃO restaurar**. Encerrar a tentativa e relatar.

---

## 2. Como escolher o backup

1. Listar backups disponíveis:
   ```bash
   ls -lt backups/
   ```
2. Identificar pelo nome o timestamp (formato `db-<ISO>`).
3. Cruzar com o horário do incidente:
   - Backup deve ser **anterior ao incidente** e **o mais recente possível** dentro dessa condição.
   - Se incidente foi às 14:00 e o backup mais recente é 22:00 do dia anterior, esse é o alvo (perde-se 16h de dados, mas é o que tem).
4. Não escolher backup com mais de 30 dias sem autorização explícita.
5. Se houver dúvida sobre integridade: pular pra fase de validação antes de qualquer restore.

---

## 3. Como validar o arquivo de backup

Antes de restaurar, confirmar que o backup **não está corrompido**:

### Backup em formato JSON (atual)

```bash
# Confere se todos os arquivos JSON são parseáveis
for f in backups/db-2026-05-26T22-36-09/*.json; do
  if ! node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null; then
    echo "CORROMPIDO: $f"
  fi
done
echo "validacao concluida"
```

### Backup em formato SQL (pg_dump futuro)

```bash
# Confere início e fim do arquivo
head -10 backups/db-XXXX.sql | grep -E "PostgreSQL database dump"
tail -3 backups/db-XXXX.sql | grep -E "PostgreSQL database dump complete"
```

### Tamanho mínimo plausível

- `product.json` deve ter > 1 MB (catálogo tem milhares de produtos).
- `productSize.json` deve ter > 500 KB.
- Se algum arquivo crítico estiver < 1 KB com banco populado: backup corrompido.

---

## 4. Como restaurar em ambiente separado

⚠️ **NUNCA EM PRODUÇÃO DIRETAMENTE.**

### Etapas

1. **Criar banco staging novo no Railway** (se não existir):
   - Novo serviço Postgres separado da produção.
   - Anotar a `DATABASE_URL` desse staging.
2. **Setar `.env.staging`** com a nova URL:
   ```
   DATABASE_URL="postgresql://...staging..."
   ```
3. **Rodar migration** no staging:
   ```bash
   DATABASE_URL="$STAGING_URL" npx prisma migrate deploy
   ```
4. **Restaurar dados**:
   - Para backup JSON: escrever script de import (ainda não existe — fora do escopo deste ciclo).
   - Para backup SQL: `psql "$STAGING_URL" < backups/db-XXXX.sql`
5. **NÃO apontar produção pra staging.** O staging é só pra teste.

---

## 5. Como conferir dados críticos após restore

Após restore em staging, verificar:

### Contagens básicas

```sql
SELECT 'Product'           AS tbl, COUNT(*) FROM "Product"
UNION ALL SELECT 'ProductSize',     COUNT(*) FROM "ProductSize"
UNION ALL SELECT 'StoreStock',      COUNT(*) FROM "StoreStock"
UNION ALL SELECT 'StocktakeBipe',   COUNT(*) FROM "StocktakeBipe"
UNION ALL SELECT 'XmlFiscalDocument', COUNT(*) FROM "XmlFiscalDocument"
UNION ALL SELECT 'XmlFiscalItem',   COUNT(*) FROM "XmlFiscalItem"
UNION ALL SELECT 'User',            COUNT(*) FROM "User"
UNION ALL SELECT 'Store',           COUNT(*) FROM "Store"
UNION ALL SELECT 'Transaction',     COUNT(*) FROM "Transaction";
```

Comparar com:
- Contagens registradas no momento do backup (se foi documentado).
- Estimativas conhecidas:
  - `Product` ~5.187
  - `Store` 6 (LOJA01-LOJA06)
  - `User` na ordem de centenas

Discrepâncias > 5% → investigar antes de promover staging a produção.

### Integridade referencial

```sql
-- ProductSize sem Product pai?
SELECT COUNT(*) FROM "ProductSize" ps
LEFT JOIN "Product" p ON p.id = ps."productId"
WHERE p.id IS NULL;
-- Esperado: 0

-- StoreStock sem ProductSize pai?
SELECT COUNT(*) FROM "StoreStock" ss
LEFT JOIN "ProductSize" ps ON ps.id = ss."productSizeId"
WHERE ps.id IS NULL;
-- Esperado: 0

-- StocktakeBipe órfãos?
SELECT COUNT(*) FROM "StocktakeBipe" sb
WHERE sb."productSizeId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "ProductSize" WHERE id = sb."productSizeId");
-- Esperado: 0
```

### Dados de negócio

- `Store.code` = LOJA01..LOJA06 todos presentes
- Pelo menos 1 `User` com `role='superadmin'` (você)
- `FiscalIssuer` tem 6 CNPJs (um por loja)
- `categoryNode` populado

---

## 6. Tabelas críticas a conferir (resumo)

| Tabela | Por quê é crítica |
|---|---|
| `Product` | Cérebro do catálogo. Sem ele, vendedor não acha produto, e-commerce não vende. |
| `ProductSize` | SKU/EAN por tamanho. Sem ele, bipe e venda quebram. |
| `StoreStock` | Quantidade real em loja. Crítico pra contagem física e venda. |
| `StocktakeBipe` | Histórico de contagem. Define quanto foi bipado vs comprado vs vendido. |
| `XmlFiscalDocument` | NFes importadas. Sem ele, perde-se origem de cada produto. |
| `XmlFiscalItem` | Itens das NFes. Sem ele, fallback do bipe quebra. |
| `User` | Cliente final + vendedor + admin. Carteira TenisCash atrelada. |
| `Store` | As 6 lojas (LOJA01-LOJA06). Sem ele, nada vincula a loja física. |
| `Transaction` | Movimentações da carteira TenisCash. Dinheiro do cliente. |

---

## 7. Proibição de restore direto em produção sem autorização explícita

Operações abaixo são **PROIBIDAS** sem aprovação humana em conversa registrada:

- ❌ `psql "$PROD_URL" < backup.sql`
- ❌ `pg_restore -d "$PROD_URL" backup.dump`
- ❌ Qualquer script Node que faça `prisma.<tabela>.createMany` apontando pra produção
- ❌ `DROP TABLE` em produção
- ❌ `TRUNCATE` em produção
- ❌ Restore parcial direto em produção (ex: "só restaurar Product")

---

## 8. Checklist de aprovação humana

Antes de executar restore em produção, marcar **TODOS** os itens. Falhar em qualquer um = não restaurar.

- [ ] Dono autorizou explicitamente no chat com texto claro como "autorizo restore de produção a partir do backup X".
- [ ] Backup foi validado (todos os JSONs parseáveis OU SQL com início/fim íntegros).
- [ ] Restore foi testado em staging primeiro, e todas as contagens e queries de integridade passaram.
- [ ] Snapshot do estado atual de produção foi feito antes (pg_dump da prod no momento).
- [ ] Janela de manutenção foi comunicada às 6 lojas (vendedores param de bipar).
- [ ] Crons foram desabilitados (`marketingCron`, `messagesCron`, `fiscalDraftJob`).
- [ ] Quem vai executar tem permissão de admin no banco e no Railway.
- [ ] Plano de rollback existe (se o restore piorar, voltar pro snapshot pré-restore).
- [ ] Operação registrada em log: quem, quando, qual backup, qual incidente motivou.

---

## 9. Pós-restore

- [ ] Testar 1 bipe em LOJA04 (ambiente seguro).
- [ ] Conferir 1 listagem de produtos (`GET /api/admin/inventory/products?limit=5`).
- [ ] Conferir saldo de 1 carteira TenisCash conhecida.
- [ ] Conferir que `npm start` sobe sem erro.
- [ ] Reativar crons.
- [ ] Comunicar lojas que sistema voltou.
- [ ] Documentar o restore (motivo, backup usado, hora, quem aprovou, problemas observados).
