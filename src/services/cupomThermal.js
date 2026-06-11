// Cupom térmico NFC-e em HTML 80mm (área útil 62mm, calibrada pra TM-T20X).
// Imprime na altura do conteúdo (impressora corta no fim) e com números em
// negrito (a térmica renderiza negrito muito mais nítido que peso fino).
// Usado pelo endpoint /api/admin/fiscal/documents/:id/print (fiscal.js).

const { XMLParser } = require('fast-xml-parser');
const QRCode = require('qrcode');

const TPAG_LABEL = { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito', '04': 'Cartão de Débito', '05': 'Crédito Loja', '10': 'Vale Alimentação', '11': 'Vale Refeição', '12': 'Vale Presente', '13': 'Vale Combustível', '15': 'Boleto', '16': 'Depósito', '17': 'PIX', '18': 'Transf. Bancária', '19': 'Fidelidade', '90': 'Sem pagamento', '99': 'Outros' };
const brl = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtCnpj = c => { c = String(c || '').replace(/\D/g, ''); return c.length === 14 ? c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : c; };
const fmtCep = c => { c = String(c || '').replace(/\D/g, ''); return c.length === 8 ? c.replace(/(\d{5})(\d{3})/, '$1-$2') : c; };

async function buildCupomThermalHtml(doc) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false });
  const x = parser.parse(doc.xmlContent);
  const NFe = x.NFe || (x.nfeProc && x.nfeProc.NFe);
  const inf = NFe.infNFe;
  const supl = NFe.infNFeSupl || {};
  const ide = inf.ide || {}, emit = inf.emit || {}, ender = emit.enderEmit || {};
  const dets = inf.det ? (Array.isArray(inf.det) ? inf.det : [inf.det]) : [];
  const tot = (inf.total && inf.total.ICMSTot) || {};
  const pag = inf.pag || {};
  const pgs = pag.detPag ? (Array.isArray(pag.detPag) ? pag.detPag : [pag.detPag]) : [];
  const vTroco = Number(pag.vTroco || 0);

  const nomeTopo = (doc.issuer && doc.issuer.fantasyName) || emit.xFant || emit.xNome || '';
  const dataEmi = ide.dhEmi ? new Date(ide.dhEmi).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : '';
  const dataAut = doc.createdAt ? new Date(doc.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : dataEmi;

  const dest = inf.dest;
  let consumidor = 'CONSUMIDOR NÃO IDENTIFICADO';
  if (dest) {
    if (dest.CPF) consumidor = 'CPF: ' + dest.CPF;
    else if (dest.CNPJ) consumidor = 'CNPJ: ' + fmtCnpj(dest.CNPJ);
    if (dest.xNome) consumidor += ' - ' + dest.xNome;
  }
  const chaveFmt = (doc.accessKey || '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();

  let qrDataUrl = '';
  try { qrDataUrl = await QRCode.toDataURL(String(supl.qrCode || ''), { margin: 0, scale: 6, errorCorrectionLevel: 'M' }); } catch (e) {}

  const itensHtml = dets.map((d, i) => {
    const p = d.prod || {};
    const qt = Number(p.qCom || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    return '<div class="it"><div class="sm"><span class="b">' + (i + 1) + '</span> ' + esc(p.cProd) + ' ' + esc(p.xProd) + '</div>'
      + '<div class="row sm"><span>' + qt + ' ' + esc(p.uCom) + ' x ' + brl(p.vUnCom) + '</span><span class="b">' + brl(p.vProd) + '</span></div></div>';
  }).join('');

  let pagHtml = pgs.map(pp => '<div class="row"><span>' + (TPAG_LABEL[pp.tPag] || 'Pagamento') + '</span><span class="b">' + brl(pp.vPag) + '</span></div>').join('');
  if (vTroco > 0) pagHtml += '<div class="row"><span>Troco</span><span class="b">' + brl(vTroco) + '</span></div>';

  const homolog = String(ide.tpAmb) === '2';
  const descHtml = Number(tot.vDesc) > 0 ? '<div class="row"><span>Descontos R$</span><span class="b">-' + brl(tot.vDesc) + '</span></div>' : '';
  const homologHtml = homolog ? '<div class="c b" style="margin-top:4px">EMITIDA EM HOMOLOGAÇÃO - SEM VALOR FISCAL</div>' : '';
  const qrHtml = qrDataUrl ? '<img class="qr" src="' + qrDataUrl + '">' : '';

  // PROCON Municipal no cupom (boa prática CDC — a Chianca imprime). Escolhido pela
  // CIDADE DO EMITENTE lida do XML (xMun). Dados LITERAIS das fontes: João Pessoa =
  // cupom Chianca (foto do dono 2026-06-11); Campina Grande = portal oficial
  // procon.campinagrande.pb.gov.br. Cidade fora do mapa → bloco não sai (nunca chutar).
  const PROCONS = [
    { re: /joao pessoa|joão pessoa/i, end: 'Av. Dom Pedro I, 473 - Centro, Joao Pessoa - PB', fone: '(83) 3213-4702' },
    { re: /campina grande/i, end: 'Rua Pref. Ernani Lautitzen, 226 - Centro, Campina Grande - PB', fone: '151 / (83) 3065-8980' },
  ];
  const _procon = PROCONS.find(p => p.re.test(String(ender.xMun || '')));
  const proconHtml = _procon
    ? '<hr><div class="c b sm">PROCON Municipal</div><div class="c sm">' + esc(_procon.end) + '</div><div class="c sm">Fone: ' + esc(_procon.fone) + '</div>'
    : '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cupom ${esc(doc.number)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { width: 80mm; background: #fff; }
  body { width: 62mm; margin: 0 0 0 5mm; background: #fff; padding: 1.5mm 2mm; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5px; font-weight: 500; line-height: 1.32; color: #000; overflow-wrap: anywhere; word-break: break-word; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .c { text-align: center; } .b { font-weight: 800; } .sm { font-size: 9.5px; } .lg { font-size: 13px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .it { margin: 2px 0; }
  .chave { word-break: break-all; font-size: 10px; font-weight: 700; letter-spacing: .3px; }
  img.qr { width: 34mm; height: 34mm; display: block; margin: 5px auto; }
  .btn { display: block; width: 100%; padding: 12px; margin: 10px 0 4px; background: #0a843d; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 800; cursor: pointer; }
  @media print { .btn { display: none !important; } }
</style></head><body>
<div class="c b lg">${esc(nomeTopo)}</div>
<div class="c sm">CNPJ ${fmtCnpj(emit.CNPJ)} - IE ${esc(emit.IE)}</div>
<div class="c sm">${esc(ender.xLgr)}, ${esc(ender.nro)} - ${esc(ender.xBairro)}</div>
<div class="c sm">${esc(ender.xMun)}/${esc(ender.UF)} - CEP ${fmtCep(ender.CEP)}</div>
<hr>
<div class="c b sm">DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>
<hr>
${itensHtml}
<hr>
<div class="row"><span>Qtde. total de itens</span><span class="b">${dets.length}</span></div>
<div class="row"><span>Valor total R$</span><span class="b">${brl(tot.vProd)}</span></div>
${descHtml}
<div class="row b lg"><span>VALOR A PAGAR R$</span><span>${brl(tot.vNF)}</span></div>
<hr>
<div class="b sm">FORMA DE PAGAMENTO</div>
<div class="sm">${pagHtml}</div>
${proconHtml}
<hr>
<div class="c sm">Consulte pela Chave de Acesso em</div>
<div class="c sm b">${esc(supl.urlChave || 'www.sefaz.pb.gov.br/nfce/consulta')}</div>
<div class="c chave">${chaveFmt}</div>
<hr>
<div class="c b sm">${esc(consumidor)}</div>
<div class="c sm">NFC-e n. ${esc(ide.nNF)}  Serie ${esc(ide.serie)}</div>
<div class="c sm">Emissao: ${dataEmi}</div>
<div class="c sm" style="margin-top:3px">Protocolo de Autorizacao</div>
<div class="c b">${esc(doc.protocol || '')}</div>
<div class="c sm">${dataAut}</div>
${qrHtml}
<div class="c sm">Tributos Totais Incidentes (Lei Fed. 12.741/2012): R$ ${brl(tot.vTotTrib)}</div>
${homologHtml}
<button class="btn" onclick="window.print()">IMPRIMIR CUPOM</button>
<script>window.addEventListener('load',function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},350);});</script>
</body></html>`;
}

module.exports = { buildCupomThermalHtml };
