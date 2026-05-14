// =====================================================================
// Mapa fornecedor → site oficial + marca pra busca de imagem/descrição.
// Quando um produto vem dum desses fornecedores, a busca usa o site
// oficial como filtro e a marca correta no nome da query.
// =====================================================================

const SUPPLIER_META = {
  // CooperShoes → fabrica Converse no Brasil
  '02675611000750': {
    site: 'converse.com.br',
    brand: 'Converse',
    notes: 'Plataforma Magento; descrição em <div class="product attribute description">',
  },
  // Lu Martins Confecções → marca Let's Gym
  '20071305000100': {
    site: 'letsgym.com.br',
    brand: "Lets Gym",
    notes: 'Plataforma PopStore; produtos abrem em modal, sem URL própria por produto',
  },
  // Recco → marca Alto Giro
  '76795418000102': {
    site: 'altogiro.com.br',
    brand: 'Alto Giro',
  },
  // Hope → linha Hope Resort (beachwear/moda praia)
  '03007414000130': {
    site: 'hoperesort.com.br',
    brand: 'Hope Resort',
  },
  // Filo SA → marca Body for Sure
  '30535975002390': {
    site: 'bodyforsure.com.br',
    brand: 'Body for Sure',
  },
  // Top Confecções Votuporanga → marca Caju Brasil
  '07458302000157': {
    site: 'cajubrasil.com.br',
    brand: 'Caju Brasil',
  },
  // FILA Brasil
  '41923935000208': {
    site: 'fila.com.br',
    brand: 'Fila',
  },
  '41923935000127': {
    site: 'fila.com.br',
    brand: 'Fila',
  },
  // Skechers
  '08562929000469': {
    site: 'skechers.com.br',
    brand: 'Skechers',
  },
  // Lupo
  '43948405000169': {
    site: 'lupo.com.br',
    brand: 'Lupo',
  },
  '01933349000572': {
    site: 'lupo.com.br',
    brand: 'Lupo',
  },
  // Cambuci / Penalty
  '61088894002402': {
    site: 'penalty.com.br',
    brand: 'Penalty',
  },
  '61088894002909': {
    site: 'penalty.com.br',
    brand: 'Penalty',
  },
  '61088894000884': {
    site: 'penalty.com.br',
    brand: 'Penalty',
  },
  // Brooks (via Macroport)
  '12400169000622': {
    site: 'brooksrunning.com.br',
    brand: 'Brooks',
  },
};

function getSupplierMeta(cnpj) {
  if (!cnpj) return null;
  const clean = String(cnpj).replace(/\D/g, '');
  return SUPPLIER_META[clean] || null;
}

function siteForSupplier(cnpj) {
  const m = getSupplierMeta(cnpj);
  return m ? m.site : null;
}

function brandForSupplier(cnpj) {
  const m = getSupplierMeta(cnpj);
  return m ? m.brand : null;
}

module.exports = { SUPPLIER_META, getSupplierMeta, siteForSupplier, brandForSupplier };
