// =====================================================================
// Páginas públicas das MEDALHAS
//  /verificar           verificador (cola o código, arrasta a imagem, ou #c=<credencial>)
//  /v/:serial           mesma página, já buscando a medalha pelo número de série
//  /verificar?baixar=1  o verificador como ARQUIVO ÚNICO (funciona offline,
//                       sem o nosso servidor: scripts e estilos embutidos)
//  /estante/:handle     estante pública de troféus do atleta
//  /medalhas/gerador    ferramenta do organizador (template + emissão + revogação)
//  /medalhas/demo       galeria de exemplo
//  /ns/medalha/v1       contexto JSON-LD da extensão "medal" das credenciais
// =====================================================================
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '../../public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const escAttr = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let verifyHtmlCache = null;
function verifyHtml() {
  if (verifyHtmlCache && process.env.NODE_ENV === 'production') return verifyHtmlCache;
  // Tudo embutido: a página não carrega nada do nosso servidor pra verificar.
  const inline = (file) => '<script>\n' + read('medalhas/' + file).replace(/<\/script/gi, '<\\/script') + '\n</script>';
  const html = read('medalhas/verificar.html')
    .replace('<!--CSS-->', '<style>\n' + read('medalhas/medal-ui.css') + '\n' + read('medalhas/medal-card.css') + '\n</style>' /* ui primeiro: tem o @import da fonte */)
    .replace('<!--SCRIPTS-->', [inline('medal-verify.js'), inline('medal-template.js'), inline('medal-card.js')].join('\n'));
  verifyHtmlCache = html;
  return html;
}

function sendVerify(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.query.baixar) res.set('Content-Disposition', 'attachment; filename="verificador-medalhas-club.html"');
  res.type('html').send(verifyHtml());
}

function mount(app) {
  app.get(['/verificar', '/verificar/'], sendVerify);
  app.get('/v/:serial', sendVerify);

  app.get('/estante/:handle', async (req, res) => {
    let html = read('medalhas/estante.html');
    let title = 'Estante de medalhas — Club Sports & Tennis';
    let desc = 'Conquistas esportivas verificadas, assinadas pelos organizadores.';
    try {
      const medals = require('./medals');
      const s = await medals.shelf(req.params.handle);
      const gold = s.medals.filter((m) => m.tier === 'GOLD').length;
      title = (s.athlete.name || 'Atleta') + ' — estante de medalhas';
      desc = s.medals.length + (s.medals.length === 1 ? ' medalha verificada' : ' medalhas verificadas') + (gold ? ' · ' + gold + ' de ouro' : '') + ' · Club Sports & Tennis';
    } catch (_) { /* atleta inexistente: a página mostra o aviso */ }
    html = html.replace(/\{\{OG_TITLE\}\}/g, escAttr(title)).replace(/\{\{OG_DESC\}\}/g, escAttr(desc));
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  });

  app.get(['/medalhas/gerador', '/medalhas/gerador/'], (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(PUB, 'medalhas/gerador.html'), { cacheControl: false }); });
  app.get(['/medalhas/demo', '/medalhas/demo/'], (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(PUB, 'medalhas/demo.html'), { cacheControl: false }); });

  app.get('/ns/medalha/v1', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.type('application/ld+json').send(JSON.stringify(require('./medals').jsonLdContext()));
  });
}

module.exports = { mount, verifyHtml };
