/**
 * Cria/atualiza um LOGIN INSTITUCIONAL de loja (role=store) — o acesso do PDV
 * travado a UMA loja. O register público exige OTP de WhatsApp; o login só
 * compara o bcrypt do `pin`, então criamos/atualizamos o User direto no banco.
 *
 * Idempotente: se o telefone já existe, atualiza senha + loja + reativa.
 * NÃO mexe em saldo (balance) nem em nada do cliente.
 *
 * Uso (roda contra o banco do DATABASE_URL — em produção, Railway):
 *   node scripts/create-store-login.js --phone=83989042285 --pass=1233 --store=LOJA05
 *   node scripts/create-store-login.js --phone=83989042285 --pass=1233 --store=LOJA05 --name="Loja Tambaú"
 *
 * Flags:
 *   --phone   telefone (só dígitos importam; o resto é limpo)   [obrigatório]
 *   --pass    senha de acesso                                    [obrigatório]
 *   --store   código da loja (LOJA01..LOJA06)                    [obrigatório]
 *   --name    nome exibido da conta (default = nome da loja)     [opcional]
 *   --apply   executa de fato (sem ela = dry-run, só mostra)     [opcional]
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}
const APPLY = process.argv.includes('--apply');

(async () => {
  const rawPhone = arg('phone');
  const pass = arg('pass');
  const storeCode = (arg('store') || '').toUpperCase();
  const customName = arg('name');

  if (!rawPhone || !pass || !storeCode) {
    console.error('Faltou flag. Ex: node scripts/create-store-login.js --phone=83989042285 --pass=1233 --store=LOJA05 --apply');
    process.exitCode = 1;
    return;
  }

  const phone = rawPhone.replace(/\D/g, '');
  if (phone.length < 10) {
    console.error(`Telefone inválido (poucos dígitos): "${rawPhone}" -> "${phone}"`);
    process.exitCode = 1;
    return;
  }

  const store = await prisma.store.findUnique({ where: { code: storeCode } });
  if (!store) {
    console.error(`Loja com code="${storeCode}" não encontrada. Rode prisma/seed-stores.js ou confira o código.`);
    process.exitCode = 1;
    return;
  }
  if (!store.active) console.warn(`AVISO: a loja ${storeCode} está inativa (active=false).`);

  const name = customName || store.name;
  const existing = await prisma.user.findUnique({ where: { phone } });

  console.log('===== CRIAR LOGIN DE LOJA (role=store) =====');
  console.log('Telefone :', phone);
  console.log('Senha    :', pass);
  console.log('Loja     :', store.code, '—', store.name, `(id ${store.id})`);
  console.log('Nome     :', name);
  console.log('Ação     :', existing ? `ATUALIZAR conta existente (id ${existing.id}, role atual=${existing.role})` : 'CRIAR conta nova');
  console.log('Modo     :', APPLY ? 'APPLY (vai gravar)' : 'DRY-RUN (nada gravado — adicione --apply)');

  if (existing && (existing.balance || 0) > 0) {
    console.warn(`\n⚠️  Esse telefone JÁ pertence a um usuário com saldo T$ ${existing.balance}. ` +
      'Transformar em login de loja vai mudar o role dessa conta. Confirme que é o número certo antes do --apply.');
  }

  if (!APPLY) {
    console.log('\nDry-run: nada foi gravado. Rode de novo com --apply pra efetivar.');
    return;
  }

  const hash = await bcrypt.hash(pass, 10);
  let user;
  if (existing) {
    user = await prisma.user.update({
      where: { id: existing.id },
      data: { pin: hash, role: 'store', storeId: store.id, active: true, name },
      select: { id: true, name: true, phone: true, role: true, storeId: true, active: true },
    });
    console.log('\n✅ Conta ATUALIZADA:', JSON.stringify(user));
  } else {
    user = await prisma.user.create({
      data: {
        name,
        phone,
        pin: hash,
        role: 'store',
        storeId: store.id,
        active: true,
        balance: 0,
        lgpdAccepted: true,
        lgpdDate: new Date(),
      },
      select: { id: true, name: true, phone: true, role: true, storeId: true, active: true },
    });
    console.log('\n✅ Conta CRIADA:', JSON.stringify(user));
  }
  console.log(`\nLogin em /loja → telefone ${phone} / senha ${pass} → cai direto em ${store.name}.`);
})()
  .catch((e) => { console.error('ERRO:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
