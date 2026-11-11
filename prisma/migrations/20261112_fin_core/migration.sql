-- Financeiro do varejo — Fase 1 (base). Aditivo e idempotente: roda no boot e antes
-- de cada rota /api/fin (finSchema.js), também por cima de um banco criado por db push.
-- Valores em CENTAVOS INTEIROS. Separador de comandos: linha "-- @statement".

CREATE TABLE IF NOT EXISTS "FinNature" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "dreGroup" TEXT NOT NULL,
  "parentId" TEXT,
  "analytic" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "inactiveReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinNature_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "FinNature_code_key" ON "FinNature"("code")
-- @statement
CREATE INDEX IF NOT EXISTS "FinNature_parentId_idx" ON "FinNature"("parentId")
-- @statement
CREATE TABLE IF NOT EXISTS "FinAccount" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "storeId" TEXT,
  "fiscalIssuerId" TEXT,
  "bankCode" TEXT,
  "agency" TEXT,
  "accountNumber" TEXT,
  "pixKey" TEXT,
  "acquirerKey" TEXT,
  "openingBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "openingDate" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "inactiveReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinAccount_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "FinAccount_storeId_idx" ON "FinAccount"("storeId")
-- @statement
CREATE INDEX IF NOT EXISTS "FinAccount_type_idx" ON "FinAccount"("type")
-- @statement
CREATE TABLE IF NOT EXISTS "FinAuditLog" (
  "id" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorId" TEXT,
  "actorRole" TEXT,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT,
  "requestId" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinAuditLog_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "FinAuditLog_entity_entityId_idx" ON "FinAuditLog"("entity", "entityId")
-- @statement
CREATE INDEX IF NOT EXISTS "FinAuditLog_at_idx" ON "FinAuditLog"("at")
-- @statement
CREATE OR REPLACE FUNCTION "fin_audit_log_append_only"() RETURNS trigger AS $fin$
BEGIN
  RAISE EXCEPTION 'FinAuditLog aceita somente inclusão (auditoria imutável)';
END
$fin$ LANGUAGE plpgsql
-- @statement
DROP TRIGGER IF EXISTS "FinAuditLog_append_only" ON "FinAuditLog"
-- @statement
CREATE TRIGGER "FinAuditLog_append_only" BEFORE UPDATE OR DELETE ON "FinAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "fin_audit_log_append_only"()
-- @statement
DROP TRIGGER IF EXISTS "FinAuditLog_no_truncate" ON "FinAuditLog"
-- @statement
CREATE TRIGGER "FinAuditLog_no_truncate" BEFORE TRUNCATE ON "FinAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "fin_audit_log_append_only"()
-- @statement
-- Plano de contas gerencial inicial do varejo (modelo editável pelo dono). Grupos (sintéticos)
-- não recebem lançamento; só as contas analíticas. ON CONFLICT: nunca sobrescreve o que o dono mudou.
INSERT INTO "FinNature" ("id", "code", "name", "kind", "dreGroup", "parentId", "analytic") VALUES
  ('finnat_01', '01', 'Receitas', 'RECEITA', 'RECEITA_BRUTA', NULL, false),
  ('finnat_01_01', '01.01', 'Venda de mercadorias - lojas físicas', 'RECEITA', 'RECEITA_BRUTA', 'finnat_01', true),
  ('finnat_01_02', '01.02', 'Venda de mercadorias - e-commerce', 'RECEITA', 'RECEITA_BRUTA', 'finnat_01', true),
  ('finnat_01_03', '01.03', 'Outras receitas operacionais', 'RECEITA', 'RECEITA_BRUTA', 'finnat_01', true),
  ('finnat_02', '02', 'Deduções da receita', 'DESPESA', 'DEDUCOES', NULL, false),
  ('finnat_02_01', '02.01', 'Devoluções e cancelamentos de vendas', 'DESPESA', 'DEDUCOES', 'finnat_02', true),
  ('finnat_02_02', '02.02', 'TenisCash usado pelos clientes', 'DESPESA', 'DEDUCOES', 'finnat_02', true),
  ('finnat_02_03', '02.03', 'Impostos sobre vendas (ICMS, PIS, COFINS)', 'DESPESA', 'DEDUCOES', 'finnat_02', true),
  ('finnat_03', '03', 'Custo das mercadorias', 'DESPESA', 'CMV', NULL, false),
  ('finnat_03_01', '03.01', 'Compra de mercadorias para revenda', 'DESPESA', 'FORA_DRE', 'finnat_03', true),
  ('finnat_03_02', '03.02', 'Frete sobre compras', 'DESPESA', 'CMV', 'finnat_03', true),
  ('finnat_04', '04', 'Despesas com vendas', 'DESPESA', 'COMERCIAL', NULL, false),
  ('finnat_04_01', '04.01', 'Taxas de cartão (adquirente)', 'DESPESA', 'TAXAS_MEIOS_PAGTO', 'finnat_04', true),
  ('finnat_04_02', '04.02', 'Taxas de PIX e gateway', 'DESPESA', 'TAXAS_MEIOS_PAGTO', 'finnat_04', true),
  ('finnat_04_03', '04.03', 'Comissões de vendedores', 'DESPESA', 'PESSOAL', 'finnat_04', true),
  ('finnat_04_04', '04.04', 'Marketing e publicidade', 'DESPESA', 'MARKETING', 'finnat_04', true),
  ('finnat_04_05', '04.05', 'Fretes de entrega', 'DESPESA', 'COMERCIAL', 'finnat_04', true),
  ('finnat_04_06', '04.06', 'Embalagens', 'DESPESA', 'COMERCIAL', 'finnat_04', true),
  ('finnat_05', '05', 'Pessoal', 'DESPESA', 'PESSOAL', NULL, false),
  ('finnat_05_01', '05.01', 'Salários', 'DESPESA', 'PESSOAL', 'finnat_05', true),
  ('finnat_05_02', '05.02', 'Encargos (INSS, FGTS)', 'DESPESA', 'PESSOAL', 'finnat_05', true),
  ('finnat_05_03', '05.03', 'Benefícios (vale-transporte, alimentação)', 'DESPESA', 'PESSOAL', 'finnat_05', true),
  ('finnat_05_04', '05.04', 'Férias, 13º e rescisões', 'DESPESA', 'PESSOAL', 'finnat_05', true),
  ('finnat_05_05', '05.05', 'Pró-labore', 'DESPESA', 'PESSOAL', 'finnat_05', true),
  ('finnat_06', '06', 'Ocupação', 'DESPESA', 'OCUPACAO', NULL, false),
  ('finnat_06_01', '06.01', 'Aluguel', 'DESPESA', 'OCUPACAO', 'finnat_06', true),
  ('finnat_06_02', '06.02', 'Condomínio e IPTU', 'DESPESA', 'OCUPACAO', 'finnat_06', true),
  ('finnat_06_03', '06.03', 'Energia elétrica', 'DESPESA', 'OCUPACAO', 'finnat_06', true),
  ('finnat_06_04', '06.04', 'Água', 'DESPESA', 'OCUPACAO', 'finnat_06', true),
  ('finnat_06_05', '06.05', 'Manutenção da loja', 'DESPESA', 'OCUPACAO', 'finnat_06', true),
  ('finnat_07', '07', 'Despesas administrativas', 'DESPESA', 'ADMINISTRATIVA', NULL, false),
  ('finnat_07_01', '07.01', 'Internet e telefone', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_07_02', '07.02', 'Software e sistemas', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_07_03', '07.03', 'Contabilidade', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_07_04', '07.04', 'Material de escritório e limpeza', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_07_05', '07.05', 'Tarifas bancárias', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_07_06', '07.06', 'Aluguel de maquininha (POS)', 'DESPESA', 'TAXAS_MEIOS_PAGTO', 'finnat_07', true),
  ('finnat_07_99', '07.99', 'Outras despesas administrativas', 'DESPESA', 'ADMINISTRATIVA', 'finnat_07', true),
  ('finnat_08', '08', 'Resultado financeiro', 'DESPESA', 'FINANCEIRA', NULL, false),
  ('finnat_08_01', '08.01', 'Juros e multas pagos', 'DESPESA', 'FINANCEIRA', 'finnat_08', true),
  ('finnat_08_02', '08.02', 'Antecipação de recebíveis', 'DESPESA', 'FINANCEIRA', 'finnat_08', true),
  ('finnat_08_03', '08.03', 'Rendimentos e juros recebidos', 'RECEITA', 'FINANCEIRA', 'finnat_08', true),
  ('finnat_09', '09', 'Impostos sobre o lucro', 'DESPESA', 'IMPOSTOS_LUCRO', NULL, false),
  ('finnat_09_01', '09.01', 'IRPJ', 'DESPESA', 'IMPOSTOS_LUCRO', 'finnat_09', true),
  ('finnat_09_02', '09.02', 'CSLL', 'DESPESA', 'IMPOSTOS_LUCRO', 'finnat_09', true),
  ('finnat_10', '10', 'Movimentos fora da DRE', 'TRANSFERENCIA', 'FORA_DRE', NULL, false),
  ('finnat_10_01', '10.01', 'Transferência entre contas', 'TRANSFERENCIA', 'FORA_DRE', 'finnat_10', true),
  ('finnat_10_02', '10.02', 'Empréstimos (entrada e pagamento do principal)', 'TRANSFERENCIA', 'FORA_DRE', 'finnat_10', true),
  ('finnat_10_03', '10.03', 'Retirada de sócios e distribuição de lucros', 'TRANSFERENCIA', 'FORA_DRE', 'finnat_10', true),
  ('finnat_10_04', '10.04', 'Investimentos e imobilizado', 'TRANSFERENCIA', 'FORA_DRE', 'finnat_10', true),
  ('finnat_10_05', '10.05', 'Adiantamento a fornecedor', 'TRANSFERENCIA', 'FORA_DRE', 'finnat_10', true),
  ('finnat_99', '99', 'A classificar', 'DESPESA', 'A_CLASSIFICAR', NULL, false),
  ('finnat_99_99', '99.99', 'A classificar', 'DESPESA', 'A_CLASSIFICAR', 'finnat_99', true)
ON CONFLICT ("code") DO NOTHING
