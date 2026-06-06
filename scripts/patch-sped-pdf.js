/*
 * patch-sped-pdf.js — corrige bugs do renderizador DANFE/DANFCe (node-sped-pdf) que
 * NÃO são configuráveis pela API da lib. Roda no postinstall (sobrevive a redeploy do
 * Railway, que reconstrói node_modules). Idempotente e nunca quebra o build (exit 0).
 *
 * Bugs corrigidos:
 *  1) DANFCe (NFC-e) imprimia "Protocolo de Autorização 000000000000000" fixo — ignorava
 *     o protocolo real. Passa a ler xml.infProt.nProt (vem do nfeProc montado em fiscal.js).
 *  2) DANFCe imprimia data de autorização = data de emissão; passa a usar dhRecbto real.
 *  3) DANFCe imprimia a URL de consulta fixa de MT (www.sefaz.mt.gov.br); passa a usar a
 *     urlChave do próprio XML (PB).
 *  4) DANFe (NF-e mod 55) lia o protocolo só em xml.protNFe.infProt (some após normalizar);
 *     adiciona fallback para xml.infProt.
 *
 * Só altera a IMPRESSÃO. Não toca no XML assinado/transmitido à SEFAZ.
 */
const fs = require('fs');

function findTarget() {
  try { return require.resolve('node-sped-pdf'); } catch (e) {}
  const guess = require('path').join(process.cwd(), 'node_modules', 'node-sped-pdf', 'dist', 'index.js');
  return fs.existsSync(guess) ? guess : null;
}

const PATCHES = [
  {
    name: 'DANFCe protocolo real',
    marker: '(xml.infProt && xml.infProt.nProt) ? ("Protocolo de Autoriza',
    from: 'const protocolo = infNFe.procEmi === "0" ? "Protocolo n\\xE3o informado" : "Protocolo de Autoriza\\xE7\\xE3o 000000000000000";',
    to:   'const protocolo = (xml.infProt && xml.infProt.nProt) ? ("Protocolo de Autoriza\\xE7\\xE3o " + xml.infProt.nProt) : (infNFe.procEmi === "0" ? "Protocolo n\\xE3o informado" : "Protocolo de Autoriza\\xE7\\xE3o 000000000000000");',
  },
  {
    name: 'DANFCe data de autorizacao real',
    marker: '(xml.infProt && xml.infProt.dhRecbto) ? ("Data de Autoriza',
    from: 'const dataAut = `Data de Autoriza\\xE7\\xE3o ${dataFormatada} ${horaFormatada}`;',
    to:   'const dataAut = (xml.infProt && xml.infProt.dhRecbto) ? ("Data de Autoriza\\xE7\\xE3o " + new Date(xml.infProt.dhRecbto).toLocaleString("pt-BR")) : `Data de Autoriza\\xE7\\xE3o ${dataFormatada} ${horaFormatada}`;',
  },
  {
    name: 'DANFCe URL de consulta (urlChave do XML)',
    marker: '${supl.urlChave || "www.sefaz.mt.gov.br/nfce/consulta"}',
    from: 'text: `www.sefaz.mt.gov.br/nfce/consulta`,',
    to:   'text: `${supl.urlChave || "www.sefaz.mt.gov.br/nfce/consulta"}`,',
  },
  {
    name: 'DANFe protocolo fallback xml.infProt',
    marker: '(xml.protNFe?.infProt?.nProt || xml.infProt?.nProt)',
    from: 'text: `${xml.protNFe?.infProt?.nProt || ""} - ${xml.protNFe?.infProt?.dhRecbto ? new Date(xml.protNFe.infProt.dhRecbto).toLocaleString("pt-BR") : ""}`,',
    to:   'text: `${(xml.protNFe?.infProt?.nProt || xml.infProt?.nProt) || ""} - ${(xml.protNFe?.infProt?.dhRecbto || xml.infProt?.dhRecbto) ? new Date(xml.protNFe?.infProt?.dhRecbto || xml.infProt?.dhRecbto).toLocaleString("pt-BR") : ""}`,',
  },
];

(function main() {
  try {
    const file = findTarget();
    if (!file) { console.log('[patch-sped-pdf] node-sped-pdf nao encontrado — pulando.'); return; }
    let src = fs.readFileSync(file, 'utf8');
    let changed = false;
    for (const p of PATCHES) {
      if (src.includes(p.marker)) { console.log('[patch-sped-pdf] ja aplicado: ' + p.name); continue; }
      if (src.includes(p.from)) { src = src.replace(p.from, p.to); changed = true; console.log('[patch-sped-pdf] OK: ' + p.name); }
      else { console.log('[patch-sped-pdf] AVISO: trecho nao encontrado (lib mudou?): ' + p.name); }
    }
    if (changed) { fs.writeFileSync(file, src, 'utf8'); console.log('[patch-sped-pdf] gravado: ' + file); }
    else { console.log('[patch-sped-pdf] nada a fazer.'); }
  } catch (e) {
    console.log('[patch-sped-pdf] erro (ignorado, build segue): ' + (e && e.message));
  }
})();
