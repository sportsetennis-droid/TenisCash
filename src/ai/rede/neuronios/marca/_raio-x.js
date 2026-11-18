// =====================================================================
// marca/_raio-x — calcula o RAIO-X de cada marca a partir do banco real.
// Só leitura. Nenhum número inventado: o que não existe no banco sai como
// null / "dado-faltante" (ex.: venda sem custo gravado → margem parcial).
//
// Regras da casa respeitadas:
//   · COMPRADO = Σ ProductSize.stock (NF-e de entrada); nunca recalculado.
//   · LOCALIZADO = Σ StoreStock > 0 por loja (o físico conferido/bipado).
//   · Venda do SITE = Sale.erpReference 'NS-…' (pedido Nuvemshop); o resto
//     é venda de LOJA FÍSICA (Sale.storeId → Store.code).
//   · Loja online respeita o físico das lojas da Nuvemshop (gate oficial).
// =====================================================================
const { chave, ficha } = require('../../regras/marcas');
const { assessProductForNuvemshop, nuvemshopStockStoreIds, nuvemshopStoreStocksQuery } = require('../../../../services/nuvemshopEligibility');

const DIA = 86400000;
const n0 = (v) => (v == null ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;
const TOP = 8;

function novaMarca(k) {
  return {
    marca: k,
    nomes: new Set(),
    cards: 0,
    cardsComEstoque: 0,
    comprado: 0,
    localizado: 0,
    porLoja: {},
    negativos: { linhas: 0, unidades: 0, itens: [] },
    vendas: { d7: { un: 0, rs: 0 }, d30: { un: 0, rs: 0, custoRS: 0, unSemCusto: 0 }, porCanal30: {} },
    parados: { cards: 0, unidades: 0, valorCustoRS: 0, semCusto: 0, itens: [] },
    ruptura: { cards: 0, itens: [] },
    site: { publicados: 0, publicadosSemEstoque: 0, prontosParaSubir: 0, bloqueados: 0, motivos: {}, itens: [] },
    // Conferência = estoque NOVO (bipes das rodadas de substituição em curso, não canceladas) × Nuvemshop
    conferencia: {
      cardsComprados: 0, cardsBipados: 0, compradosBipados: 0, bipadosSemCompra: 0, unidadesBipadas: 0, bipesPendentes: 0, porLoja: {},
      bipadosNaNuvemshop: 0,
      publicadosNaoBipados: 0, itensPublicadosNaoBipados: [],
      bipadosForaNuvemshop: 0, foraNuvemshopNasLojasDoSite: 0, foraNuvemshopSoEmOutrasLojas: 0, itensBipadosForaNuvemshop: [],
      compradosNaoBipados: 0, itensCompradosNaoBipados: [],
    },
    cadastro: { semCor: 0, semFoto: 0, menosDe5Fotos: 0, semCusto: 0, precoZerado: 0, precoAbaixoCusto: 0, tamanhoTecnicoComEstoque: 0, itensPreco: [] },
  };
}

async function calcular(ler, { agora = new Date(), soMarca = null, diasParado = 90 } = {}) {
  const d7 = new Date(agora.getTime() - 7 * DIA);
  const d30 = new Date(agora.getTime() - 30 * DIA);

  // 1) cards ativos (sem carregar imagem: só contagem)
  const prods = await ler.$queryRawUnsafe(
    'SELECT p.id, p.brand, p.name, p.sku, p.category, p.price, p."costPrice", p."createdAt", ' +
    "  (p.\"aiContext\"->>'color') AS cor, " +
    "  (CASE WHEN coalesce(p.\"imageUrl\",'') <> '' THEN 1 ELSE 0 END) AS tem_principal, " +
    "  (CASE WHEN jsonb_typeof(p.\"imageUrls\"::jsonb) = 'array' THEN jsonb_array_length(p.\"imageUrls\"::jsonb) ELSE 0 END) AS n_galeria, " +
    '  EXISTS (SELECT 1 FROM "NuvemshopProductMapping" m WHERE m."localProductId" = p.id AND m."syncStatus" <> \'hidden-invalid\') AS publicado ' +
    'FROM "Product" p WHERE p.active = true');
  const M = new Map();
  const P = new Map();
  for (const p of prods) {
    const k = chave(p.brand);
    if (!k || (soMarca && k !== soMarca)) continue;
    if (!M.has(k)) M.set(k, novaMarca(k));
    const m = M.get(k);
    m.nomes.add(p.brand);
    m.cards++;
    const fotos = Math.max(n0(p.tem_principal), n0(p.n_galeria));
    if (!String(p.cor || '').trim()) m.cadastro.semCor++;
    if (fotos === 0) m.cadastro.semFoto++;
    if (fotos < 5) m.cadastro.menosDe5Fotos++;
    const custo = n0(p.costPrice), preco = n0(p.price);
    if (!(custo > 0)) m.cadastro.semCusto++;
    if (!(preco > 0)) m.cadastro.precoZerado++;
    if (custo > 0 && preco > 0 && preco <= custo) {
      m.cadastro.precoAbaixoCusto++;
      if (m.cadastro.itensPreco.length < TOP) m.cadastro.itensPreco.push({ productId: p.id, nome: p.name, preco, custo });
    }
    if (p.publicado) m.site.publicados++;
    P.set(p.id, { ...p, k, fotos, comprado: 0, localizado: 0, localizadoNS: 0, lojas: {}, un30: 0, ultVenda: null });
  }
  if (!M.size) return [];
  const ids = [...P.keys()];

  // 2) comprado e tamanho técnico
  const sz = await ler.$queryRawUnsafe(
    'SELECT ps."productId" AS pid, SUM(ps.stock)::int AS comprado FROM "ProductSize" ps WHERE ps."productId" = ANY($1::text[]) GROUP BY 1', ids);
  for (const r of sz) { const p = P.get(r.pid); if (p) p.comprado = n0(r.comprado); }

  // 3) localizado por loja (StoreStock) + negativos
  const nsIds = new Set(nuvemshopStockStoreIds());
  const ss = await ler.$queryRawUnsafe(
    'SELECT ps."productId" AS pid, ss."storeId" AS sid, st.code AS loja, SUM(ss.stock)::int AS un, ' +
    "  SUM(CASE WHEN ss.stock > 0 AND ps.size LIKE 'T-%' THEN ss.stock ELSE 0 END)::int AS tecnico " +
    'FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" JOIN "Store" st ON st.id = ss."storeId" ' +
    'WHERE ss.stock <> 0 AND ps."productId" = ANY($1::text[]) GROUP BY 1, 2, 3', ids);
  for (const r of ss) {
    const p = P.get(r.pid); if (!p) continue;
    const m = M.get(p.k); const un = n0(r.un);
    if (un < 0) {
      m.negativos.linhas++; m.negativos.unidades += un;
      if (m.negativos.itens.length < TOP) m.negativos.itens.push({ productId: p.id, nome: p.name, loja: r.loja, unidades: un });
      continue;
    }
    p.localizado += un; p.lojas[r.loja] = (p.lojas[r.loja] || 0) + un;
    if (nsIds.has(r.sid)) p.localizadoNS += un;
    m.porLoja[r.loja] = (m.porLoja[r.loja] || 0) + un;
    if (n0(r.tecnico) > 0) m.cadastro.tamanhoTecnicoComEstoque++;
  }

  // 3b) estoque NOVO: bipes das rodadas de substituição em curso (só bipe novo vale; rodada cancelada fica fora)
  const bp = await ler.$queryRawUnsafe(
    'SELECT ps."productId" AS pid, st.code AS loja, ' +
    '  COUNT(*) FILTER (WHERE b.applied)::int AS aplicados, COUNT(*) FILTER (WHERE NOT b.applied)::int AS pendentes ' +
    'FROM "StocktakeBipe" b JOIN "StocktakeRound" r ON r.id = b."roundId" JOIN "ProductSize" ps ON ps.id = b."productSizeId" ' +
    'JOIN "Store" st ON st.id = b."storeId" ' +
    "WHERE r.\"operationType\" = 'replacement' AND r.status <> 'cancelled' AND b.\"excludedAt\" IS NULL AND ps.\"productId\" = ANY($1::text[]) " +
    'GROUP BY 1, 2', ids);
  for (const r of bp) {
    const p = P.get(r.pid); if (!p) continue;
    const m = M.get(p.k);
    const ap = n0(r.aplicados);
    p.bipados = (p.bipados || 0) + ap;
    p.lojasBipadas = p.lojasBipadas || {};
    if (ap) p.lojasBipadas[r.loja] = (p.lojasBipadas[r.loja] || 0) + ap;
    m.conferencia.bipesPendentes += n0(r.pendentes);
    if (ap) m.conferencia.porLoja[r.loja] = (m.conferencia.porLoja[r.loja] || 0) + ap;
  }

  // 4) vendas (loja física × site) — 30 dias, mais a última venda de cada card
  const vd = await ler.$queryRawUnsafe(
    'SELECT si."productId" AS pid, si.brand, ' +
    "  CASE WHEN s.\"erpReference\" LIKE 'NS-%' THEN 'SITE' ELSE coalesce(st.code, 'SEM LOJA') END AS canal, " +
    '  SUM(si.quantity)::int AS un, SUM(si."totalPrice")::float AS rs, ' +
    '  SUM(CASE WHEN si."unitCost" > 0 THEN si."unitCost" * si.quantity ELSE 0 END)::float AS custo, ' +
    '  SUM(CASE WHEN si."unitCost" > 0 THEN si."totalPrice" ELSE 0 END)::float AS rs_com_custo, ' +
    '  SUM(CASE WHEN coalesce(si."unitCost", 0) <= 0 THEN si.quantity ELSE 0 END)::int AS un_sem_custo, ' +
    '  SUM(CASE WHEN s."createdAt" >= $2 THEN si.quantity ELSE 0 END)::int AS un7, ' +
    '  SUM(CASE WHEN s."createdAt" >= $2 THEN si."totalPrice" ELSE 0 END)::float AS rs7 ' +
    'FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" LEFT JOIN "Store" st ON st.id = s."storeId" ' +
    "WHERE s.status = 'completed' AND s.\"createdAt\" >= $1 GROUP BY 1, 2, 3", d30, d7);
  for (const r of vd) {
    const p = r.pid ? P.get(r.pid) : null;
    const k = p ? p.k : chave(r.brand);
    if (!k || !M.has(k)) continue;
    const m = M.get(k);
    const un = n0(r.un);
    m.vendas.d30.un += un; m.vendas.d30.rs += n0(r.rs); m.vendas.d30.custoRS += n0(r.custo); m.vendas.d30.unSemCusto += n0(r.un_sem_custo);
    m.vendas.d30.rsComCusto = (m.vendas.d30.rsComCusto || 0) + n0(r.rs_com_custo);
    m.vendas.d7.un += n0(r.un7); m.vendas.d7.rs += n0(r.rs7);
    const c = m.vendas.porCanal30[r.canal] || (m.vendas.porCanal30[r.canal] = { un: 0, rs: 0 });
    c.un += un; c.rs += n0(r.rs);
    if (p) p.un30 += un;
  }
  const ult = await ler.$queryRawUnsafe(
    'SELECT si."productId" AS pid, MAX(s."createdAt") AS ult FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" ' +
    "WHERE s.status = 'completed' AND si.\"productId\" = ANY($1::text[]) GROUP BY 1", ids);
  for (const r of ult) { const p = P.get(r.pid); if (p) p.ultVenda = r.ult ? new Date(r.ult) : null; }

  // 5) por card: estoque, parado, ruptura, site
  const paraAvaliar = [];
  for (const p of P.values()) {
    const m = M.get(p.k);
    m.comprado += p.comprado;
    m.localizado += p.localizado;
    if (p.localizado > 0) m.cardsComEstoque++;
    // parado: tem físico e não vende há N dias (base: última venda, senão cadastro)
    if (p.localizado > 0) {
      const desde = p.ultVenda || new Date(p.createdAt);
      const dias = Math.floor((agora.getTime() - desde.getTime()) / DIA);
      if (dias >= diasParado) {
        m.parados.cards++; m.parados.unidades += p.localizado;
        const custo = n0(p.costPrice);
        if (custo > 0) m.parados.valorCustoRS += p.localizado * custo; else m.parados.semCusto++;
        m.parados.itens.push({ productId: p.id, nome: p.name, unidades: p.localizado, lojas: p.lojas, dias, valorCustoRS: custo > 0 ? r2(p.localizado * custo) : null, base: p.ultVenda ? 'última venda' : 'cadastro' });
      }
    }
    // ruptura: vendeu nos últimos 30 dias e não tem físico em loja nenhuma
    if (p.un30 >= 1 && p.localizado <= 0) {
      m.ruptura.cards++;
      m.ruptura.itens.push({ productId: p.id, nome: p.name, vendidos30: p.un30, comprado: p.comprado });
    }
    if (p.publicado && p.localizadoNS <= 0) m.site.publicadosSemEstoque++;
    if (!p.publicado && p.localizadoNS > 0) paraAvaliar.push(p.id);
    // conferência: bipado no estoque novo × Nuvemshop
    const cf = m.conferencia; const bip = p.bipados || 0;
    if (p.comprado > 0) cf.cardsComprados++;
    if (bip > 0) {
      cf.cardsBipados++; cf.unidadesBipadas += bip;
      if (p.comprado > 0) cf.compradosBipados++; else cf.bipadosSemCompra++;
      if (p.publicado) cf.bipadosNaNuvemshop++;
      else {
        cf.bipadosForaNuvemshop++;
        if (p.localizadoNS > 0) cf.foraNuvemshopNasLojasDoSite++; else cf.foraNuvemshopSoEmOutrasLojas++;
        cf.itensBipadosForaNuvemshop.push({ productId: p.id, nome: p.name, unidades: bip, lojas: p.lojasBipadas, nasLojasDoSite: p.localizadoNS > 0 });
      }
    } else {
      if (p.publicado) { cf.publicadosNaoBipados++; cf.itensPublicadosNaoBipados.push({ productId: p.id, nome: p.name, comprado: p.comprado, localizado: p.localizado }); }
      if (p.comprado > 0) { cf.compradosNaoBipados++; cf.itensCompradosNaoBipados.push({ productId: p.id, nome: p.name, comprado: p.comprado }); }
    }
  }

  // 6) site: o que tem físico nas lojas da Nuvemshop e ainda não subiu → pronto ou bloqueado (gate oficial)
  for (let i = 0; i < paraAvaliar.length; i += 300) {
    const lote = await ler.product.findMany({
      where: { id: { in: paraAvaliar.slice(i, i + 300) } },
      include: { sizes: { include: { storeStocks: nuvemshopStoreStocksQuery() } } },
    });
    for (const prod of lote) {
      const p = P.get(prod.id); const m = M.get(p.k);
      const a = assessProductForNuvemshop(prod);
      if (a.eligible) { m.site.prontosParaSubir++; continue; }
      m.site.bloqueados++;
      for (const motivo of a.reasons) { const t = motivo.replace(/^tamanho .+?: fisico.*/, 'físico maior que comprado').replace(/^tamanho .+ sem codigo de barras$/, 'tamanho sem código de barras'); m.site.motivos[t] = (m.site.motivos[t] || 0) + 1; }
      if (m.site.itens.length < TOP) m.site.itens.push({ productId: p.id, nome: p.name, motivos: a.reasons.slice(0, 4) });
    }
  }

  // 7) fecha cada marca: ordena listas, margem, cobertura, alertas e nota de atenção
  const out = [];
  for (const m of M.values()) {
    m.parados.itens.sort((a, b) => (b.valorCustoRS || 0) - (a.valorCustoRS || 0) || b.dias - a.dias);
    m.parados.itens = m.parados.itens.slice(0, TOP);
    m.parados.valorCustoRS = r2(m.parados.valorCustoRS);
    m.ruptura.itens.sort((a, b) => b.vendidos30 - a.vendidos30);
    m.ruptura.itens = m.ruptura.itens.slice(0, TOP);
    const cf = m.conferencia;
    cf.itensPublicadosNaoBipados = cf.itensPublicadosNaoBipados.sort((a, b) => b.localizado - a.localizado || b.comprado - a.comprado).slice(0, TOP);
    cf.itensBipadosForaNuvemshop = cf.itensBipadosForaNuvemshop.sort((a, b) => (b.nasLojasDoSite - a.nasLojasDoSite) || b.unidades - a.unidades).slice(0, TOP);
    cf.itensCompradosNaoBipados = cf.itensCompradosNaoBipados.sort((a, b) => b.comprado - a.comprado).slice(0, TOP);
    cf.pctCardsBipados = cf.cardsComprados ? r2(100 * cf.compradosBipados / cf.cardsComprados) : null; // % dos cards COMPRADOS (NF-e) que já foram bipados
    const v = m.vendas.d30;
    v.rs = r2(v.rs); v.custoRS = r2(v.custoRS); m.vendas.d7.rs = r2(m.vendas.d7.rs);
    for (const c of Object.values(m.vendas.porCanal30)) c.rs = r2(c.rs);
    // margem bruta só sobre as vendas COM custo gravado (as sem custo ficam de fora e são contadas em unSemCusto)
    v.rsComCusto = r2(v.rsComCusto || 0);
    v.margemPct = v.rsComCusto > 0 ? r2(100 * (1 - v.custoRS / v.rsComCusto)) : null;
    m.coberturaDias = v.un > 0 ? Math.round(m.localizado / (v.un / 30)) : null;
    m.alertas = alertas(m);
    m.atencao = nota(m);
    m.nomes = [...m.nomes];
    m.ficha = ficha(m.marca);
    out.push(m);
  }
  out.sort((a, b) => b.atencao - a.atencao || b.vendas.d30.rs - a.vendas.d30.rs);
  return out;
}

// Alertas em linguagem do dono, do mais grave pro menos grave.
function alertas(m) {
  const a = [];
  const add = (gravidade, area, texto, extra = {}) => a.push({ gravidade, area, texto, ...extra });
  if (m.cadastro.precoAbaixoCusto) add(3, 'preço', `${m.cadastro.precoAbaixoCusto} card(s) com preço de venda menor ou igual ao custo`, { itens: m.cadastro.itensPreco });
  if (m.negativos.linhas) add(3, 'estoque', `${m.negativos.linhas} tamanho(s) com estoque NEGATIVO (${m.negativos.unidades} un) — venda de par não localizado`, { itens: m.negativos.itens });
  if (m.ruptura.cards) add(2, 'venda', `${m.ruptura.cards} card(s) venderam nos últimos 30 dias e estão sem estoque localizado — falta repor OU falta contar na loja`, { itens: m.ruptura.itens });
  if (m.parados.cards) add(2, 'estoque', `${m.parados.cards} card(s) parados há 90+ dias (${m.parados.unidades} un${m.parados.valorCustoRS ? ', R$ ' + m.parados.valorCustoRS.toLocaleString('pt-BR') + ' a custo' : ''})`, { itens: m.parados.itens });
  const cf = m.conferencia || {};
  if (cf.publicadosNaoBipados) add(2, 'conferência', `${cf.publicadosNaoBipados} card(s) estão na Nuvemshop e NÃO foram bipados no estoque novo — o site pode vender o que não foi conferido`, { itens: cf.itensPublicadosNaoBipados });
  if (cf.bipadosForaNuvemshop) add(1, 'conferência', `${cf.bipadosForaNuvemshop} card(s) bipados no estoque novo e fora da Nuvemshop (${cf.foraNuvemshopNasLojasDoSite} nas lojas que vendem no site, ${cf.foraNuvemshopSoEmOutrasLojas} só em outras lojas)`, { itens: cf.itensBipadosForaNuvemshop });
  if (cf.compradosNaoBipados) add(1, 'conferência', `${cf.compradosNaoBipados} card(s) comprados e ainda não bipados em loja nenhuma`, { itens: cf.itensCompradosNaoBipados });
  if (m.site.prontosParaSubir) add(2, 'site', `${m.site.prontosParaSubir} card(s) prontos para subir no site e ainda fora`);
  if (m.site.publicadosSemEstoque) add(1, 'site', `${m.site.publicadosSemEstoque} card(s) publicados sem estoque físico nas lojas do site`);
  if (m.site.bloqueados) add(1, 'site', `${m.site.bloqueados} card(s) com estoque nas lojas do site mas barrados pelo cadastro`, { motivos: m.site.motivos, itens: m.site.itens });
  if (m.cadastro.semFoto) add(1, 'cadastro', `${m.cadastro.semFoto} card(s) sem nenhuma foto`);
  if (m.cadastro.semCor) add(1, 'cadastro', `${m.cadastro.semCor} card(s) sem cor`);
  if (m.cadastro.tamanhoTecnicoComEstoque) add(1, 'cadastro', `${m.cadastro.tamanhoTecnicoComEstoque} card(s) com tamanho técnico (T-) com estoque`);
  if (m.cadastro.semCusto) add(1, 'cadastro', `${m.cadastro.semCusto} card(s) sem custo gravado`);
  return a.sort((x, y) => y.gravidade - x.gravidade);
}

// Nota de atenção 0–100: quanto a marca precisa do dono hoje (não é nota de desempenho).
function nota(m) {
  let s = 0;
  s += Math.min(30, m.cadastro.precoAbaixoCusto * 10);
  s += Math.min(20, m.negativos.linhas * 4);
  s += Math.min(20, m.ruptura.cards * 3);
  s += Math.min(15, m.parados.cards);
  s += Math.min(10, m.site.prontosParaSubir * 2);
  s += Math.min(15, ((m.conferencia && m.conferencia.publicadosNaoBipados) || 0) * 2);
  s += Math.min(5, m.cadastro.semFoto);
  return Math.min(100, Math.round(s));
}

module.exports = { calcular, alertas, nota };
