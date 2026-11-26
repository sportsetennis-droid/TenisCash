// Página /meustenis (vitrine + editor) e /meustenis/:handle (guarda-tênis público de uma pessoa).
// O HTML é o mesmo (public/meustenis.html); aqui só preenchemos o título e a prévia do link
// (Instagram/WhatsApp leem og:title/og:image sem rodar JavaScript).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../public/meustenis.html');
let cache = null;
const html = () => (cache && process.env.NODE_ENV === 'production' ? cache : (cache = fs.readFileSync(FILE, 'utf8')));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_IMG = '/brand/sports-tennis-icon-512.png?v=2';

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}
const abs = (req, u) => (!u || /^data:/i.test(u) ? origin(req) + DEFAULT_IMG : /^https?:\/\//i.test(u) ? u : origin(req) + (u.startsWith('/') ? u : '/' + u));

function render(req, res, { title, desc, image, status = 200 }) {
  const out = html()
    .split('{{OG_TITLE}}').join(esc(title))
    .split('{{OG_DESC}}').join(esc(desc))
    .split('{{OG_IMAGE}}').join(esc(abs(req, image)));
  res.set('Cache-Control', 'no-store');
  res.status(status).type('html').send(out);
}

function mount(app) {
  app.get(['/meustenis', '/meustenis/'], (req, res) =>
    render(req, res, { title: 'Meus Tênis — Club Sports & Tennis', desc: 'Seu guarda-tênis digital: mostre os tênis que você tem num link só seu e veja os da galera do Club.' }));

  app.get('/meustenis/:handle', async (req, res) => {
    const { prisma } = require('../middleware');
    const mt = require('./meusTenis');
    try {
      const d = await mt.publicCloset(prisma, req.params.handle, {});
      const first = d.items.find((i) => i.photo);
      return render(req, res, {
        title: d.user.name + ' — Meus Tênis',
        desc: d.items.length + (d.items.length === 1 ? ' tênis' : ' tênis') + ' no guarda-tênis de ' + d.user.name + ' no Club Sports & Tennis.',
        image: first ? first.photo : null,
      });
    } catch (e) {
      if (!e.status) console.error('[meustenis page]', e.message);
      return render(req, res, { title: 'Meus Tênis — Club Sports & Tennis', desc: 'Guarda-tênis digital do Club Sports & Tennis.', status: e.status === 404 ? 404 : 200 });
    }
  });
}

module.exports = { mount };
