// Controle remoto das maquinas das lojas (canal proprio, SEM AnyDesk).
// Uso:
//   node scripts/_agent_control.js status                  -> estado de todas as maquinas + comandos pendentes
//   node scripts/_agent_control.js cmd LOJA01 restart-agent -> enfileira um comando p/ o Supervisor da loja executar
//   node scripts/_agent_control.js result <id>             -> ve o resultado de um comando
// Tipos de comando: restart-agent | update-agent | update-supervisor | tailscale-up | funnel-up | get-health | get-log | ping
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const l of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const TZ = 'America/Fortaleza'; const f = (d) => d ? new Date(d).toLocaleString('pt-BR', { timeZone: TZ }) : '-';
const TYPES = ['restart-agent', 'update-agent', 'update-supervisor', 'tailscale-up', 'funnel-up', 'get-health', 'get-log', 'capture-list', 'capture-pull', 'ping'];

(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'cmd') {
    if (!a || !TYPES.includes(b)) { console.log('uso: cmd <STORECODE> <tipo> [arg]\ntipos:', TYPES.join(', ')); process.exit(1); }
    const arg3 = process.argv[5];
    const data = { storeCode: a.toUpperCase(), type: b, createdBy: 'cli' };
    if (b === 'capture-pull' && arg3) data.args = { name: arg3 };
    const c = await prisma.agentCommand.create({ data });
    console.log(`enfileirado p/ ${a.toUpperCase()}: ${b}${arg3 ? ' ' + arg3 : ''}  (id ${c.id})`);
    console.log('o Supervisor da loja pega no proximo poll (<=45s). ver resultado: node scripts/_agent_control.js result ' + c.id);
  } else if (mode === 'result') {
    const c = await prisma.agentCommand.findUnique({ where: { id: a } });
    if (!c) { console.log('nao achei'); } else {
      console.log(`${c.storeCode} ${c.type} -> ${c.status}  (criado ${f(c.createdAt)}, atualizado ${f(c.updatedAt)})`);
      console.log('--- resultado ---\n' + (c.result || '(sem resultado ainda)'));
    }
  } else if (mode === 'view') {
    // baixa um print JA puxado pro central (autenticado com CAPTURE_VIEW_TOKEN do dono)
    const store = (a || '').toUpperCase(); const name = b;
    if (!store || !name) { console.log('uso: view <STORECODE> <arquivo.jpg>  (lista: result do capture-list)'); process.exit(1); }
    const central = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/$/, '');
    const key = process.env.CAPTURE_VIEW_TOKEN || '';
    if (!key) { console.log('falta CAPTURE_VIEW_TOKEN no .env (segredo so do dono)'); process.exit(1); }
    const r = await fetch(`${central}/api/auth/agent-capture/file/${store}/${encodeURIComponent(name)}?key=${encodeURIComponent(key)}`);
    if (!r.ok) { console.log('falha HTTP', r.status, '(o print ja foi puxado com capture-pull?)'); process.exit(1); }
    const buf = Buffer.from(await r.arrayBuffer());
    const out = path.join(__dirname, '..', 'captures-baixadas', `${store}-${name}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    console.log('salvo:', out, `(${(buf.length / 1024).toFixed(0)}KB) — abra a imagem`);
  } else {
    // status
    const hbs = await prisma.machineHeartbeat.findMany({ orderBy: { storeCode: 'asc' } });
    console.log('=== MAQUINAS (heartbeat do Supervisor) ===');
    if (!hbs.length) console.log('  (nenhuma maquina reportou ainda — Supervisor nao instalado/rodando)');
    const now = Date.now();
    for (const h of hbs) {
      const ageMin = Math.round((now - new Date(h.lastSeen).getTime()) / 60000);
      const online = ageMin <= 3 ? 'ONLINE' : `visto ha ${ageMin}min`;
      console.log(`  ${h.storeCode.padEnd(7)} ${online.padEnd(16)} agente:${h.agentHealthy ? 'OK v' + (h.agentVersion || '?') : 'CAIDO'}  sup:v${h.supervisorVersion || '?'}  host:${h.hostname || '?'}`);
    }
    const pend = await prisma.agentCommand.findMany({ where: { status: { in: ['pending', 'sent'] } }, orderBy: { createdAt: 'desc' }, take: 20 });
    console.log('\n=== COMANDOS EM ABERTO ===');
    if (!pend.length) console.log('  (nenhum)');
    for (const c of pend) console.log(`  ${c.id}  ${c.storeCode} ${c.type} [${c.status}] ${f(c.createdAt)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
