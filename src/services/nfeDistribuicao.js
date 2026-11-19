// =====================================================================
// NF-e de compra baixando sozinha da SEFAZ (dono 18/11/2026: "Resolva").
// De hora em hora, para cada CNPJ do grupo (lojas), pede ao Ambiente Nacional
// as NF-e emitidas CONTRA a loja (Distribuição DF-e), pelo agente fiscal (que
// tem o certificado). O que chega:
//   - XML completo (procNFe) → importado pelo MESMO importador do admin
//     (não cria card; entrada × transferência pela regra do CLAUDE.md).
//   - Resumo (resNFe) → registrado; com a Ciência da Operação (210210) a SEFAZ
//     libera o XML completo, que é buscado pela chave na rodada seguinte.
// Regras da SEFAZ respeitadas: sem documento novo (137) ou "consumo indevido"
// (656) → só volta a consultar depois de 1h.
// Desligar: NFE_DIST=0. Ciência automática: NFE_CIENCIA_AUTO=0 desliga.
// =====================================================================
const crypto = require('crypto');

const state = { ultimaRodada: null, rodando: false, lojas: {}, importadas: 0, resumos: 0, ciencias: 0, erros: 0, ultimoErro: null };
let ready = null;

function ensureSchema(prisma) {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "NfeDistState" (
        "cnpj" TEXT PRIMARY KEY, "ultNSU" TEXT NOT NULL DEFAULT '0', "maxNSU" TEXT, "lastCStat" TEXT, "lastMotivo" TEXT,
        "lastRunAt" TIMESTAMP(3), "nextAllowedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "NfeDistDoc" (
        "chNFe" TEXT PRIMARY KEY, "cnpjDest" TEXT NOT NULL, "emitCnpj" TEXT, "emitNome" TEXT, "valor" DOUBLE PRECISION,
        "dhEmi" TIMESTAMP(3), "situacao" TEXT, "nsu" TEXT, "kind" TEXT NOT NULL DEFAULT 'resumo',
        "cienciaAt" TIMESTAMP(3), "cienciaStatus" TEXT, "importedAt" TIMESTAMP(3), "documentId" TEXT, "erro" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NfeDistDoc_kind_idx" ON "NfeDistDoc" ("kind", "importedAt")`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const tag = (xml, t) => (String(xml || '').match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || null;

function isEnabled() { return process.env.NFE_DIST !== '0'; }
function cienciaAuto() { return process.env.NFE_CIENCIA_AUTO !== '0'; }

// Lojas do grupo com agente fiscal: cada CNPJ (filial) consulta o que foi emitido contra ele.
async function storesToQuery(prisma) {
  const stores = await prisma.store.findMany({
    where: { active: true, fiscalAgentEnabled: true, fiscalAgentUrl: { not: null }, fiscalAgentToken: { not: null }, fiscalIssuerId: { not: null } },
    select: { id: true, code: true, fiscalAgentEnabled: true, fiscalAgentUrl: true, fiscalAgentToken: true, fiscalIssuer: { select: { cnpj: true, environment: true } } },
    orderBy: { code: 'asc' },
  });
  const seen = new Set();
  return stores.filter((s) => {
    const cnpj = String(s.fiscalIssuer && s.fiscalIssuer.cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14 || seen.has(cnpj)) return false;
    seen.add(cnpj); s.cnpj = cnpj; s.environment = s.fiscalIssuer.environment || 'production';
    return true;
  });
}

async function saveResumo(prisma, cnpjDest, nsu, xml) {
  const ch = tag(xml, 'chNFe');
  if (!ch) return null;
  const dh = tag(xml, 'dhEmi');
  await prisma.$executeRaw`INSERT INTO "NfeDistDoc" ("chNFe","cnpjDest","emitCnpj","emitNome","valor","dhEmi","situacao","nsu","kind")
    VALUES (${ch}, ${cnpjDest}, ${tag(xml, 'CNPJ')}, ${tag(xml, 'xNome')}, ${Number(tag(xml, 'vNF') || 0)}, ${dh ? new Date(dh) : null}, ${tag(xml, 'cSitNFe')}, ${nsu}, 'resumo')
    ON CONFLICT ("chNFe") DO UPDATE SET "situacao" = EXCLUDED."situacao", "updatedAt" = NOW()`;
  state.resumos++;
  return ch;
}

async function saveCompleta(prisma, cnpjDest, nsu, xml) {
  const ch = (String(xml).match(/Id="NFe(\d{44})"/) || [])[1] || tag(xml, 'chNFe');
  if (!ch) return null;
  const already = await prisma.xmlFiscalDocument.findFirst({ where: { accessKey: ch }, select: { id: true } });
  let documentId = already ? already.id : null, erro = null;
  if (!already) {
    try {
      const r = await require('./nfeXmlImporter').importNfeXml(prisma, xml, { fileName: 'sefaz-dist-' + ch + '.xml' });
      documentId = r.documentId || null;
      if (r.duplicate) erro = null; else state.importadas++;
    } catch (e) { erro = String(e.message || e).slice(0, 300); state.erros++; }
  }
  await prisma.$executeRaw`INSERT INTO "NfeDistDoc" ("chNFe","cnpjDest","emitCnpj","emitNome","valor","dhEmi","nsu","kind","importedAt","documentId","erro")
    VALUES (${ch}, ${cnpjDest}, ${tag(xml, 'CNPJ')}, ${tag(xml, 'xNome')}, ${Number(tag(xml, 'vNF') || 0)}, ${tag(xml, 'dhEmi') ? new Date(tag(xml, 'dhEmi')) : null}, ${nsu}, 'completa', ${erro ? null : new Date()}, ${documentId}, ${erro})
    ON CONFLICT ("chNFe") DO UPDATE SET "kind" = 'completa', "importedAt" = COALESCE("NfeDistDoc"."importedAt", EXCLUDED."importedAt"),
      "documentId" = COALESCE(EXCLUDED."documentId", "NfeDistDoc"."documentId"), "erro" = EXCLUDED."erro", "updatedAt" = NOW()`;
  return ch;
}

async function processDocs(prisma, cnpj, docs) {
  for (const d of docs || []) {
    if (!d || !d.xml) continue;
    if (/^resNFe/.test(d.schema)) await saveResumo(prisma, cnpj, d.nsu, d.xml);
    else if (/^procNFe/.test(d.schema)) await saveCompleta(prisma, cnpj, d.nsu, d.xml);
    // resEvento/procEventoNFe: eventos (cancelamento etc.) — só ficam no NSU, não viram nota
  }
}

// Uma loja: anda pelo NSU até alcançar o máximo (até 15 chamadas por rodada).
async function runStore(prisma, store, agent) {
  const [st] = await prisma.$queryRaw`SELECT *, ("nextAllowedAt" IS NOT NULL AND "nextAllowedAt" > NOW()) AS "bloqueado" FROM "NfeDistState" WHERE "cnpj" = ${store.cnpj}`;
  if (st && st.bloqueado) return { pulou: 'aguardando 1h da SEFAZ', proxima: st.nextAllowedAt };
  let ult = (st && st.ultNSU) || '0', max = null, last = null, calls = 0, docs = 0;
  while (calls < 15) {
    calls++;
    const r = await agent(store, '/distdfe', { cnpj: store.cnpj, environment: store.environment, ultNSU: ult });
    last = r;
    if (!r || !r.status) { state.erros++; state.ultimoErro = (r && r.error) || 'sem resposta'; break; }
    if (r.status === '138') { await processDocs(prisma, store.cnpj, r.docs); docs += (r.docs || []).length; }
    if (r.ultNSU) ult = r.ultNSU;
    if (r.maxNSU) max = r.maxNSU;
    if (r.status !== '138' || !max || BigInt(ult) >= BigInt(max)) break;
  }
  const waitHour = !last || !last.status || ['137', '656'].includes(last.status) || (max && BigInt(ult) >= BigInt(max));
    await prisma.$executeRaw`INSERT INTO "NfeDistState" ("cnpj","ultNSU","maxNSU","lastCStat","lastMotivo","lastRunAt","nextAllowedAt","updatedAt")
    VALUES (${store.cnpj}, ${ult}, ${max}, ${last && last.status}, ${last && (last.motivo || last.error)}, NOW(), CASE WHEN ${!!waitHour} THEN NOW() + INTERVAL '61 minutes' ELSE NULL END, NOW())
    ON CONFLICT ("cnpj") DO UPDATE SET "ultNSU" = EXCLUDED."ultNSU", "maxNSU" = EXCLUDED."maxNSU", "lastCStat" = EXCLUDED."lastCStat",
      "lastMotivo" = EXCLUDED."lastMotivo", "lastRunAt" = NOW(), "nextAllowedAt" = EXCLUDED."nextAllowedAt", "updatedAt" = NOW()`;
  return { cStat: last && last.status, motivo: last && (last.motivo || last.error), docs, ultNSU: ult, maxNSU: max, chamadas: calls };
}

// Ciência + busca do XML completo pela chave, para resumos ainda sem XML (limite por rodada).
async function completarResumos(prisma, storesByCnpj, agent, limit = 20) {
  const pend = await prisma.$queryRaw`SELECT "chNFe","cnpjDest","cienciaAt" FROM "NfeDistDoc"
    WHERE "kind" = 'resumo' AND COALESCE("situacao",'1') = '1' ORDER BY "createdAt" ASC LIMIT ${limit}`;
  for (const p of pend) {
    const store = storesByCnpj[p.cnpjDest];
    if (!store) continue;
    if (!p.cienciaAt) {
      if (!cienciaAuto()) continue;
      const c = await agent(store, '/ciencia', { cnpj: store.cnpj, environment: store.environment, chNFe: p.chNFe });
      await prisma.$executeRaw`UPDATE "NfeDistDoc" SET "cienciaAt" = ${c && c.ok ? new Date() : null}, "cienciaStatus" = ${(c && (c.status || c.error)) || 'sem resposta'}, "updatedAt" = NOW() WHERE "chNFe" = ${p.chNFe}`;
      if (c && c.ok) state.ciencias++;
      continue; // o XML completo fica disponível alguns minutos depois: busca na próxima rodada
    }
    const r = await agent(store, '/distdfe', { cnpj: store.cnpj, environment: store.environment, chNFe: p.chNFe });
    if (r && r.status === '138') await processDocs(prisma, store.cnpj, r.docs);
  }
}

async function run(prisma, { agent } = {}) {
  if (state.rodando) return { ok: false, erro: 'já rodando' };
  state.rodando = true;
  try {
    await ensureSchema(prisma);
    const client = agent || ((store, path, body) => require('./fiscalAgentClient').callAgentPublic(store, path, body));
    const stores = await storesToQuery(prisma);
    const out = {};
    for (const s of stores) {
      try { out[s.code] = await runStore(prisma, s, client); }
      catch (e) { out[s.code] = { erro: e.message }; state.erros++; state.ultimoErro = e.message; }
    }
    await completarResumos(prisma, Object.fromEntries(stores.map((s) => [s.cnpj, s])), client).catch((e) => { state.erros++; state.ultimoErro = e.message; });
    state.lojas = out; state.ultimaRodada = new Date().toISOString();
    return { ok: true, lojas: out };
  } finally { state.rodando = false; }
}

async function resumo(prisma) {
  await ensureSchema(prisma);
  const [c] = await prisma.$queryRaw`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE "kind" = 'completa')::int AS completas,
      count(*) FILTER (WHERE "kind" = 'resumo')::int AS "soResumo",
      count(*) FILTER (WHERE "kind" = 'resumo' AND "cienciaAt" IS NOT NULL)::int AS "comCiencia",
      count(*) FILTER (WHERE "erro" IS NOT NULL)::int AS "comErro" FROM "NfeDistDoc"`;
  const lojas = await prisma.$queryRaw`SELECT "cnpj","ultNSU","maxNSU","lastCStat","lastMotivo","lastRunAt","nextAllowedAt" FROM "NfeDistState" ORDER BY "cnpj"`;
  return { documentos: c, lojas };
}

function start(prisma) {
  if (!isEnabled()) { console.log('[nfe-dist] desligado (NFE_DIST=0)'); return; }
  const cron = require('node-cron');
  cron.schedule('17 * * * *', () => run(prisma).catch((e) => { state.erros++; state.ultimoErro = e.message; }), { timezone: 'America/Fortaleza' });
  setTimeout(() => run(prisma).catch(() => {}), 3 * 60 * 1000).unref?.();
  console.log('[nfe-dist] ligado: de hora em hora (min 17)');
}

function getState() { return { ligado: isEnabled(), cienciaAutomatica: cienciaAuto(), ...state }; }

module.exports = { start, run, resumo, getState, ensureSchema, _test: { runStore, processDocs, saveResumo, completarResumos, storesToQuery } };
