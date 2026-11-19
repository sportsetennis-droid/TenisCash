// =====================================================================
// RNA — ações da Nuvemshop/conteúdo executadas SÓ depois do "sim" do dono.
// Cada ação REVALIDA as regras duras na hora (o mundo pode ter mudado desde
// a proposta) e, se a condição não vale mais, NÃO faz nada e diz por quê.
// Nenhuma ação mexe em preço, comprado (ProductSize.stock) ou StoreStock.
//   nuvem.despublicar            → nuvemshopHandlers.unpublishMappedProduct
//   nuvem.ressincronizar-estoque → nuvemshopHandlers.pushStockUpdate (só estoque físico)
//   nuvem.remover-fantasma       → desativa o card-fantasma + apaga SÓ os mappings dele
//   nuvem.aplicar-descricao      → grava longDescription se o card ainda estiver sem
// =====================================================================
const elig = require('../../../services/nuvemshopEligibility');

const handlers = () => require('../../../services/nuvemshopHandlers'); // carregado só ao executar
const texto = (v) => (v == null ? '' : String(v).trim());
const naoFez = (nota, extra = {}) => Object.assign({ ok: true, executado: false, nota }, extra);

function faltasAtuais(p) {
  const ctx = elig.contextOf(p);
  const c = ctx.classification || {};
  const inval = (v) => ['', 'A CLASSIFICAR', 'A DEFINIR', 'SEM MARCA', 'NAO DEFINIDO', 'NÃO DEFINIDO'].includes(texto(v).toLocaleUpperCase('pt-BR'));
  const f = [];
  if (!elig.hasUsableImage(p)) f.push('foto');
  if (!texto(p.longDescription) && !texto(p.shortDescription)) f.push('descricao');
  if (inval(p.category) || inval(p.subcategory) || inval(c.modality) || inval(c.tier)) f.push('classificacao');
  return f;
}

module.exports = (registrar) => {
  registrar('nuvem.despublicar', {
    descricao: 'Despublica na Nuvemshop produto publicado sem foto/descrição/classificação (não apaga card nem estoque).',
    async executar(args, { db }) {
      const id = texto(args.productId);
      if (!id) throw new Error('productId ausente');
      const p = await db.product.findUnique({ where: { id }, select: { id: true, imageUrl: true, imageUrls: true, longDescription: true, shortDescription: true, category: true, subcategory: true, aiContext: true } });
      if (!p) return naoFez('produto não existe mais');
      const mapping = await db.nuvemshopProductMapping.findUnique({ where: { localProductId: id } });
      if (!mapping) return naoFez('produto não está mais na Nuvemshop');
      if (args.nuvemshopProductId && String(mapping.nuvemshopProductId) !== String(args.nuvemshopProductId)) return naoFez('mapping mudou de NS# desde a proposta; refazer a análise');
      if (mapping.syncStatus === 'hidden-invalid') return naoFez('já estava despublicado');
      const irmaos = await db.nuvemshopProductMapping.count({ where: { nuvemshopProductId: mapping.nuvemshopProductId } });
      if (irmaos > 1) return naoFez('NS#' + mapping.nuvemshopProductId + ' é dividido por ' + irmaos + ' cards (card-fantasma): resolver o fantasma antes; despublicar esconderia o card curado');
      const faltas = faltasAtuais(p);
      if (!faltas.length) return naoFez('o card já foi completado (foto, descrição e classificação ok): não despublicado');
      const r = await handlers().unpublishMappedProduct(id, null, 'RNA aprovado pelo dono: falta ' + faltas.join('+'), mapping);
      return { ok: true, executado: !!r.unpublished, faltas, resultado: r };
    },
  });

  registrar('nuvem.ressincronizar-estoque', {
    descricao: 'Reenvia à Nuvemshop SÓ o estoque físico (Σ StoreStock das lojas da loja online) de um produto elegível.',
    async executar(args, { db }) {
      const id = texto(args.productId);
      if (!id) throw new Error('productId ausente');
      const p = await db.product.findUnique({ where: { id }, include: { sizes: { include: { storeStocks: elig.nuvemshopStoreStocksQuery() } } } });
      if (!p) return naoFez('produto não existe mais');
      const mapping = await db.nuvemshopProductMapping.findUnique({ where: { localProductId: id } });
      if (!mapping || mapping.syncStatus === 'hidden-invalid') return naoFez('produto não está publicado na Nuvemshop');
      const a = elig.assessProductForNuvemshop(p);
      if (!a.eligible) return naoFez('produto não passa mais no gate da Nuvemshop; não ressincronizado (propor despublicar)', { motivos: a.reasons });
      const r = await handlers().pushStockUpdate(id);
      return { ok: !(r.errors || []).length, executado: true, resultado: { atualizadas: r.updated, criadas: r.created, removidas: r.deleted, erros: (r.errors || []).length } };
    },
  });

  registrar('nuvem.remover-fantasma', {
    descricao: 'Desativa o card-fantasma (eco do webhook) e apaga só os mappings dele; o card curado e a loja ficam como estão.',
    async executar(args, { db }) {
      const ghostId = texto(args.ghostId); const curadoId = texto(args.curadoId); const ns = texto(args.nuvemshopProductId);
      if (!ghostId || !curadoId || !ns || ghostId === curadoId) throw new Error('argumentos inválidos');
      const [g, c] = await Promise.all([
        db.product.findUnique({ where: { id: ghostId }, select: { id: true, source: true, active: true, aiContext: true, sizes: { select: { id: true, storeStocks: { select: { stock: true } } } } } }),
        db.product.findUnique({ where: { id: curadoId }, select: { id: true, source: true } }),
      ]);
      if (!g) return naoFez('fantasma não existe mais');
      if (g.source !== 'nuvemshop') return naoFez('card não é source=nuvemshop: não é fantasma, nada feito');
      if (!c || c.source === 'nuvemshop') return naoFez('irmão curado não confere: nada feito');
      const [mg, mc] = await Promise.all([
        db.nuvemshopProductMapping.findUnique({ where: { localProductId: ghostId } }),
        db.nuvemshopProductMapping.findUnique({ where: { localProductId: curadoId } }),
      ]);
      if (!mc || String(mc.nuvemshopProductId) !== ns) return naoFez('card curado não está mapeado no NS#' + ns + ': nada feito (risco de deixar a loja órfã)');
      if (mg && String(mg.nuvemshopProductId) !== ns) return naoFez('fantasma mudou de NS#: nada feito');
      const localizado = g.sizes.reduce((s, z) => s + z.storeStocks.reduce((a, r) => a + (r.stock || 0), 0), 0);
      if (localizado > 0) return naoFez('fantasma tem ' + localizado + ' un. localizadas (StoreStock): conferir à mão, nada feito');
      let ctx = {}; try { ctx = typeof g.aiContext === 'string' ? JSON.parse(g.aiContext) : (g.aiContext || {}); } catch (_) { ctx = {}; }
      ctx.rnaFantasma = { curadoId, nuvemshopProductId: ns, em: new Date().toISOString() };
      await db.$transaction([
        db.nuvemshopVariantMapping.deleteMany({ where: { localProductId: ghostId } }),
        db.nuvemshopProductMapping.deleteMany({ where: { localProductId: ghostId } }),
        db.product.update({ where: { id: ghostId }, data: { active: false, aiContext: ctx } }),
      ]);
      return { ok: true, executado: true, fantasmaDesativado: ghostId, curadoMantido: curadoId, nuvemshopProductId: ns };
    },
  });

  registrar('nuvem.aplicar-descricao', {
    descricao: 'Grava a descrição aprovada no card (só se ele continuar sem descrição).',
    async executar(args, { db }) {
      const id = texto(args.productId); const t = texto(args.texto);
      if (!id || !t) throw new Error('productId/texto ausente');
      if (t.length > 4000) throw new Error('texto longo demais');
      const p = await db.product.findUnique({ where: { id }, select: { id: true, longDescription: true, shortDescription: true } });
      if (!p) return naoFez('produto não existe mais');
      if (texto(p.longDescription) || texto(p.shortDescription)) return naoFez('card já tem descrição: não sobrescrito');
      await db.product.update({ where: { id }, data: { longDescription: t } });
      return { ok: true, executado: true, productId: id };
    },
  });
};
