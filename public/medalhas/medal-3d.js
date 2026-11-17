// =====================================================================
// MEDALHA 3D — metal de verdade, em tempo real (WebGL / three.js).
// - Relevo CUNHADO gerado por evento: aro elevado com o nome do evento,
//   louros, escudo do evento e a colocação em alto-relevo; fundo jateado
//   (fosco) x relevo espelhado — acabamento "proof" de medalha cunhada.
// - Material físico por tier (refletância real de ouro/prata/bronze),
//   concluinte com esmalte na cor do evento, raros com verniz furta-cor.
// - Estúdio de luz próprio (softboxes) → reflexo que corre no metal
//   quando o celular inclina (giroscópio) ou o dedo/mouse passa.
// - Fita de tecido (cetim) com as cores do evento.
// Exposto em window.Medal3D: mountLive(el, view) e snapshot(view, w, h).
// Se WebGL não existir, a carta continua com a medalha vetorial.
// =====================================================================
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.187.0/+esm';

const T = window.MedalTemplate;
const TIER = {
  GOLD: { color: '#ffd27a', rough: 0.1, field: 0.62 },
  SILVER: { color: '#f2f5f8', rough: 0.08, field: 0.6 },
  BRONZE: { color: '#e9a270', rough: 0.12, field: 0.62 },
  SPECIAL: { color: '#ffd27a', rough: 0.08, field: 0.6 },
  FINISHER: { color: '#b4bac2', rough: 0.14, field: 0.6 },
};
const AWARD_ICON = { TOP_SCORER: 'BALL', MVP: 'STAR', RECORD: 'STOPWATCH' };
const isRare = (v) => (v.distinctions && v.distinctions.length > 0) || ['TOP_SCORER', 'MVP', 'RECORD'].includes(v.achievement);

// ---------------------------------------------------------------------
// Fontes: o relevo usa a fonte do template do evento (canvas precisa dela carregada)
async function fontsReady(design) {
  const f = (T.FONTS[design.font] || T.FONTS.archivo);
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`${f.italic ? 'italic ' : ''}${f.weight} 200px "${f.family}"`),
        document.fonts.load('800 80px "Archivo"'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (_) { /* segue com fallback */ }
  return f;
}

// ---------------------------------------------------------------------
// MAPA DE ALTURA da face (canvas). Branco = alto. Depois vira normal map,
// displacement e mapa de rugosidade (polido no relevo, jateado no fundo).
function drawHeight(v, f, S) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const k = S / 2048, C = S / 2;
  const gray = (h) => { const n = Math.round(h * 255); return `rgb(${n},${n},${n})`; };
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  // campo (fundo) — levemente côncavo pro centro
  const field = g.createRadialGradient(C, C, 0, C, C, 870 * k);
  field.addColorStop(0, gray(0.2)); field.addColorStop(1, gray(0.28));
  g.fillStyle = field; g.beginPath(); g.arc(C, C, 1000 * k, 0, Math.PI * 2); g.fill();
  // aro externo elevado
  g.fillStyle = gray(0.86);
  g.beginPath(); g.arc(C, C, 1000 * k, 0, Math.PI * 2); g.arc(C, C, 868 * k, 0, Math.PI * 2, true); g.fill('evenodd');
  // filete fino interno
  g.strokeStyle = gray(0.62); g.lineWidth = 10 * k;
  g.beginPath(); g.arc(C, C, 842 * k, 0, Math.PI * 2); g.stroke();
  // texto circular gravado no aro: NOME DO EVENTO • ANO
  const year = v.event && v.event.date ? new Date(v.event.date).getUTCFullYear() : '';
  const ring = (String(v.event.name || '').toUpperCase().replace(/[—–-]/g, '·') + (year ? '  ★  ' + year : '') + '  ★  ').replace(/\s+/g, ' ');
  g.save(); g.translate(C, C);
  g.fillStyle = gray(0.58);
  g.font = `800 ${Math.round(76 * k)}px "Archivo", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const circ = 2 * Math.PI * 934 * k;
  const totalW = g.measureText(ring).width;
  const reps = Math.max(1, Math.min(2, Math.floor(circ / (totalW + 40 * k))));
  const full = Array(reps).fill(ring).join('');
  const spacing = circ / g.measureText(full).width;
  let ang = -Math.PI / 2;
  for (const ch of full) {
    const w = g.measureText(ch).width * spacing;
    ang += (w / 2) / (934 * k);
    g.save(); g.rotate(ang); g.translate(0, -934 * k); g.fillText(ch, 0, 0); g.restore();
    ang += (w / 2) / (934 * k);
  }
  g.restore();
  // louros (duas ramas), folhas em gota com nervura
  const leaf = (x, y, rot, s) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = gray(0.72);
    g.beginPath(); g.moveTo(0, -60 * s); g.quadraticCurveTo(34 * s, 0, 0, 60 * s); g.quadraticCurveTo(-34 * s, 0, 0, -60 * s); g.fill();
    g.strokeStyle = gray(0.55); g.lineWidth = 5 * s; g.beginPath(); g.moveTo(0, -50 * s); g.lineTo(0, 50 * s); g.stroke();
    g.restore();
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const a = Math.PI / 2 + side * (0.42 + i * 0.165);
      const r = 690 * k;
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      const s = k * (1.3 - i * 0.045);
      leaf(x + Math.cos(a) * 28 * k, y + Math.sin(a) * 28 * k, a + side * 0.55, s);
      leaf(x - Math.cos(a) * 28 * k, y - Math.sin(a) * 28 * k, a - side * 0.25 + Math.PI, s * 0.9);
    }
  }
  // escudo do evento no topo (plataforma elevada + iniciais gravadas)
  const shield = { classic: 'M50 4 L92 16 V48 C92 74 74 90 50 98 C26 90 8 74 8 48 V16 Z', round: 'M50 4 A46 46 0 1 1 49.9 4 Z', hex: 'M50 3 L91 26 V74 L50 97 L9 74 V26 Z', pennant: 'M10 6 H90 V62 L50 96 L10 62 Z', badge: 'M50 3 L62 12 L78 10 L84 25 L96 36 L90 52 L94 68 L80 76 L72 92 L56 88 L44 88 L28 92 L20 76 L6 68 L10 52 L4 36 L16 25 L22 10 L38 12 Z' }[v.design.crest.shape] || 'M50 4 L92 16 V48 C92 74 74 90 50 98 C26 90 8 74 8 48 V16 Z';
  g.save(); g.translate(C - 150 * k, C - 735 * k); g.scale(3.0 * k, 3.0 * k);
  g.fillStyle = gray(0.66); g.fill(new Path2D(shield));
  g.strokeStyle = gray(0.8); g.lineWidth = 3; g.stroke(new Path2D(shield));
  g.fillStyle = gray(0.48); g.font = `${f.italic ? 'italic ' : ''}${f.weight} 38px "${f.family}", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(v.design.crest.initials || '').slice(0, 3), 50, 54);
  g.restore();
  // centro: colocação em alto-relevo (ou ícone da premiação)
  const icon = AWARD_ICON[v.achievement] || (v.tier === 'FINISHER' ? (T.ICONS[v.design.crest.icon] ? v.design.crest.icon : 'TROPHY') : null);
  if (icon) {
    g.save(); g.translate(C - 330 * k, C - 300 * k); g.scale(6.6 * k, 6.6 * k);
    const tmp = document.createElement('div');
    tmp.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + T.ICONS[icon] + '</svg>';
    g.strokeStyle = gray(0.97); g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
    tmp.firstChild.childNodes.forEach((n) => {
      let p = null;
      if (n.tagName === 'path') p = new Path2D(n.getAttribute('d'));
      else if (n.tagName === 'circle') { p = new Path2D(); p.arc(+n.getAttribute('cx'), +n.getAttribute('cy'), +n.getAttribute('r'), 0, Math.PI * 2); }
      else if (n.tagName === 'ellipse') { p = new Path2D(); p.ellipse(+n.getAttribute('cx'), +n.getAttribute('cy'), +n.getAttribute('rx'), +n.getAttribute('ry'), 0, 0, Math.PI * 2); }
      if (p) g.stroke(p);
    });
    g.restore();
  } else {
    const num = v.placement ? String(v.placement) : '★';
    g.save(); g.fillStyle = gray(0.98);
    g.font = `${f.italic ? 'italic ' : ''}${f.weight} ${Math.round((num.length > 1 ? 470 : 640) * k)}px "${f.family}", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const w = g.measureText(num).width;
    g.fillText(num, C - 40 * k, C + 220 * k);
    g.font = `${f.italic ? 'italic ' : ''}${f.weight} ${Math.round(230 * k)}px "${f.family}", sans-serif`;
    if (v.placement) g.fillText('º', C + w / 2 + 40 * k, C - 40 * k);
    g.restore();
  }
  // palavra do tier embaixo
  const word = ({ TOP_SCORER: 'ARTILHARIA', MVP: 'DESTAQUE', RECORD: 'RECORDE' })[v.achievement] || ({ GOLD: 'OURO', SILVER: 'PRATA', BRONZE: 'BRONZE', FINISHER: 'CONCLUINTE', SPECIAL: 'ESPECIAL' })[v.tier] || '';
  g.fillStyle = gray(0.7); g.font = `800 ${Math.round(74 * k)}px "Archivo", sans-serif`; g.textAlign = 'center';
  g.save(); g.translate(C, C + 430 * k); if ('letterSpacing' in g) g.letterSpacing = `${Math.round(18 * k)}px`; g.fillText(word, 0, 0); g.restore();
  return c;
}

// Desfoque separável (borda arredondada do cunho) sobre Float32Array
function blur(h, S, r) {
  const tmp = new Float32Array(h.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < S; y++) { let acc = 0; const row = y * S; for (let x = -r; x <= r; x++) acc += h[row + Math.min(S - 1, Math.max(0, x))]; for (let x = 0; x < S; x++) { tmp[row + x] = acc / (2 * r + 1); acc += h[row + Math.min(S - 1, x + r + 1)] - h[row + Math.max(0, x - r)]; } }
    for (let x = 0; x < S; x++) { let acc = 0; for (let y = -r; y <= r; y++) acc += tmp[Math.min(S - 1, Math.max(0, y)) * S + x]; for (let y = 0; y < S; y++) { h[y * S + x] = acc / (2 * r + 1); acc += tmp[Math.min(S - 1, y + r + 1) * S + x] - tmp[Math.max(0, y - r) * S + x]; } }
  }
}

// Gera normal map + displacement + rugosidade (+ cor/metal do esmalte no concluinte)
function faceMaps(v, f, S) {
  const src = drawHeight(v, f, S).getContext('2d').getImageData(0, 0, S, S).data;
  const raw = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) raw[i] = src[i * 4] / 255;
  const h = raw.slice();
  blur(h, S, Math.max(2, Math.round(S / 300)));
  const nrm = new Uint8ClampedArray(S * S * 4), rgh = new Uint8ClampedArray(S * S * 4), dsp = new Uint8ClampedArray(S * S * 4);
  const enamel = v.tier === 'FINISHER';
  const col = enamel ? new Uint8ClampedArray(S * S * 4) : null, met = enamel ? new Uint8ClampedArray(S * S * 4) : null;
  const ec = new THREE.Color(v.design.palette.primary);
  const tier = TIER[v.tier] || TIER.GOLD;
  const strength = S * 0.007;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, o = i * 4;
      const l = h[y * S + Math.max(0, x - 1)], r = h[y * S + Math.min(S - 1, x + 1)];
      const u = h[Math.max(0, y - 1) * S + x], d = h[Math.min(S - 1, y + 1) * S + x];
      let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      nrm[o] = (nx * 0.5 + 0.5) * 255; nrm[o + 1] = (ny * 0.5 + 0.5) * 255; nrm[o + 2] = nz * 255; nrm[o + 3] = 255;
      const hv = raw[i];
      // rugosidade: relevo polido, fundo jateado com grão
      const isField = hv < 0.35;
      const grain = (rnd() - 0.5) * 0.12;
      const rough = isField ? tier.field + grain : tier.rough + grain * 0.25;
      rgh[o] = rgh[o + 1] = rgh[o + 2] = Math.max(0, Math.min(1, rough)) * 255; rgh[o + 3] = 255;
      dsp[o] = dsp[o + 1] = dsp[o + 2] = h[i] * 255; dsp[o + 3] = 255;
      if (enamel) {
        const isEnamel = hv < 0.35;
        col[o] = isEnamel ? ec.r * 255 : 255; col[o + 1] = isEnamel ? ec.g * 255 : 255; col[o + 2] = isEnamel ? ec.b * 255 : 255; col[o + 3] = 255;
        met[o] = met[o + 1] = met[o + 2] = isEnamel ? 0 : 255; met[o + 3] = 255;
      }
    }
  }
  const tex = (arr, srgb) => { const t = new THREE.DataTexture(arr, S, S, THREE.RGBAFormat); t.needsUpdate = true; t.flipY = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { normal: tex(nrm), rough: tex(rgh), disp: tex(dsp), color: col && tex(col, true), metal: met && tex(met) };
}

// ---------------------------------------------------------------------
// Estúdio de luz (softboxes) → mapa de ambiente PMREM. Metal só fica bonito
// com reflexo de faixas de luz contrastadas.
function studioEnv(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#141210');
  const box = (w, h, x, y, z, intensity, color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color || '#ffffff').multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); scene.add(m);
  };
  // frente: faixas verticais de luz com vãos escuros → o reflexo "corre" no metal ao inclinar
  [-7.5, -3.2, 0.9, 5.2, 9].forEach((x, i) => box(i === 2 ? 2.6 : 1.7, 14, x, 1.2, 9, i === 2 ? 1.5 : 1.15, i % 2 ? '#ffe7c7' : '#ffffff'));
  box(30, 3.2, 0, 7.2, 6.5, 2.0);             // softbox de cima (brilho na borda superior)
  box(1.6, 10, -8.5, 1, 2, 2.4);              // recorte lateral esquerdo
  box(1.2, 10, 8.5, 0.5, 2, 1.8, '#ffe2bb');  // recorte lateral direito (quente)
  box(10, 1.2, 0, -7.5, 3, 0.7);              // rebatedor baixo
  box(20, 20, 0, 0, -10, 0.35, '#ffd9a8');    // fundo quente
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(scene, 0.02).texture;
  pm.dispose();
  return env;
}

// Textura da fita (cetim listrado nas cores do evento) + trama
function ribbonTexture(v) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const g = c.getContext('2d'); const p = v.design.palette;
  g.fillStyle = p.secondary; g.fillRect(0, 0, 256, 512);
  g.fillStyle = p.primary; g.fillRect(0, 0, 38, 512); g.fillRect(218, 0, 38, 512);
  g.fillStyle = p.accent; g.fillRect(108, 0, 40, 512);
  g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(100, 0, 4, 512); g.fillRect(152, 0, 4, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function weaveNormal() {
  const S = 128, d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const o = (y * S + x) * 4; const a = Math.sin(x * Math.PI / 2) * 0.35, b = Math.sin(y * Math.PI / 2) * 0.35; d[o] = (a * 0.5 + 0.5) * 255; d[o + 1] = (b * 0.5 + 0.5) * 255; d[o + 2] = 235; d[o + 3] = 255; }
  const t = new THREE.DataTexture(d, S, S); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 12); t.needsUpdate = true; return t;
}

// ---------------------------------------------------------------------
// Monta a medalha (grupo) para uma view
async function buildMedal(v, quality) {
  const f = await fontsReady(v.design);
  const S = quality === 'high' ? 2048 : 1024;
  const maps = faceMaps(v, f, S);
  const tier = TIER[v.tier] || TIER.GOLD;
  const rare = isRare(v);
  const group = new THREE.Group();
  const R = 1, TH = 0.15, BEV = 0.035;

  const metal = new THREE.MeshPhysicalMaterial({
    color: tier.color, metalness: 1, roughness: 1, roughnessMap: maps.rough,
    normalMap: maps.normal, normalScale: new THREE.Vector2(1, 1),
    displacementMap: maps.disp, displacementScale: 0.03, displacementBias: -0.008,
    envMapIntensity: 1.4,
  });
  if (maps.color) { metal.map = maps.color; metal.metalnessMap = maps.metal; metal.color = new THREE.Color('#ffffff'); metal.clearcoat = 1; metal.clearcoatRoughness = 0.06; }
  if (rare) { metal.iridescence = 0.38; metal.iridescenceIOR = 1.5; metal.iridescenceThicknessRange = [220, 600]; metal.clearcoat = 1; metal.clearcoatRoughness = 0.05; }

  // face frontal: malha polar (aceita displacement real)
  const rings = quality === 'high' ? 220 : 140, segs = quality === 'high' ? 512 : 320;
  const pos = [], uv = [], idx = [];
  const Rf = R - BEV;
  pos.push(0, 0, 0); uv.push(0.5, 0.5);
  for (let i = 1; i <= rings; i++) {
    const rr = Rf * i / rings;
    for (let j = 0; j < segs; j++) { const a = j / segs * Math.PI * 2; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; pos.push(x, y, 0); uv.push(0.5 + x / (2 * R), 0.5 + y / (2 * R)); }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + j, 1 + (j + 1) % segs);
  for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + (j + 1) % segs, c2 = 1 + i * segs + j, d2 = 1 + i * segs + (j + 1) % segs;
    idx.push(a, c2, d2, a, d2, b);
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fg.setIndex(idx); fg.computeVertexNormals();
  const face = new THREE.Mesh(fg, metal); face.position.z = TH / 2; group.add(face);

  // corpo (borda arredondada + verso), via torno
  const prof = [];
  prof.push(new THREE.Vector2(0.0001, -TH / 2));
  prof.push(new THREE.Vector2(R - BEV, -TH / 2));
  for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + i / 8 * Math.PI / 2; prof.push(new THREE.Vector2(R - BEV + Math.cos(a) * BEV, -TH / 2 + BEV + Math.sin(a) * BEV)); }
  for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2; prof.push(new THREE.Vector2(R - BEV + Math.cos(a) * BEV, TH / 2 - BEV + Math.sin(a) * BEV)); }
  prof.push(new THREE.Vector2(R - BEV, TH / 2));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 256), new THREE.MeshPhysicalMaterial({ color: maps.color ? '#9aa0a8' : tier.color, metalness: 1, roughness: 0.22, envMapIntensity: 1.25, iridescence: rare ? 0.25 : 0, clearcoat: rare ? 1 : 0 }));
  body.rotation.x = Math.PI / 2; group.add(body);

  // argola + fita
  const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.028, 24, 64), body.material);
  ringMesh.position.set(0, R + 0.07, 0); group.add(ringMesh);
  const fade = document.createElement('canvas'); fade.width = 4; fade.height = 256;
  const fg2 = fade.getContext('2d'); const gr = fg2.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#000'); gr.addColorStop(0.3, '#fff'); gr.addColorStop(1, '#fff'); fg2.fillStyle = gr; fg2.fillRect(0, 0, 4, 256);
  const ribMat = new THREE.MeshPhysicalMaterial({ transparent: true, alphaMap: new THREE.CanvasTexture(fade), map: ribbonTexture(v), normalMap: weaveNormal(), normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.5, sheen: 0.45, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'), envMapIntensity: 0.6, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(0.42, 2.4, 8, 40);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const yy = p.getY(i); const t = (yy + 1.2) / 2.4; p.setZ(i, -0.06 - Math.sin(t * Math.PI) * 0.07 + (p.getX(i) * side) * 0.08); }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, ribMat);
    m.position.set(side * 0.33, R + 1.2, -0.05); m.rotation.z = side * -0.3; group.add(m);
  }
  group.userData.dispose = () => { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { Object.values(o.material).forEach((x) => { if (x && x.isTexture) x.dispose(); }); o.material.dispose(); } }); };
  return group;
}

// ---------------------------------------------------------------------
function makeRenderer(canvas, w, h, dpr) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  return renderer;
}
// Enquadra: medalha inteira com folga embaixo, fita saindo pelo topo.
function frame(camera, aspect) {
  camera.aspect = aspect;
  const halfH = Math.max(1.48, 1.24 / aspect);
  const cy = -1.1 + halfH;
  camera.position.set(0, cy, halfH / Math.tan(THREE.MathUtils.degToRad(13)));
  camera.lookAt(0, cy, 0);
  camera.updateProjectionMatrix();
}
// ---------------------------------------------------------------------
// UM motor WebGL para a página inteira (o navegador limita contextos 3D:
// uma carta = um contexto derrubava as outras). Cada carta tem a própria
// cena/câmera; o motor desenha as visíveis e copia o quadro pro canvas 2D
// de cada carta.
let core = null;
function getCore() {
  if (core) return core;
  const canvas = document.createElement('canvas');
  const renderer = makeRenderer(canvas, 600, 720, 1);
  const env = studioEnv(renderer);
  core = { canvas, renderer, env, live: new Set(), raf: 0, lost: false };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); core.lost = true; });
  return core;
}
function makeScene(env) {
  const scene = new THREE.Scene();
  scene.environment = env;
  const key = new THREE.DirectionalLight('#ffffff', 1.2); key.position.set(2, 3, 5); scene.add(key);
  const camera = new THREE.PerspectiveCamera(26, 0.8, 0.1, 50);
  frame(camera, 0.8);
  return { scene, camera, key };
}
function renderTo(item, w, h) {
  const k = getCore();
  if (k.canvas.width !== w || k.canvas.height !== h) k.renderer.setSize(w, h, false);
  k.renderer.render(item.scene, item.camera);
}
function tick() {
  const k = core;
  k.raf = 0;
  if (!k || k.lost) return;
  let any = false;
  const now = performance.now();
  k.live.forEach((it) => {
    if (!it.visible || !it.ready) return;
    any = true;
    const t = (now - it.t0) / 1000;
    it.cx += (it.tx - it.cx) * 0.08; it.cy += (it.ty - it.cy) * 0.08; it.spin *= 0.93;
    it.medal.rotation.y = it.cx + Math.sin(t * 0.6) * 0.14 + it.spin;
    it.medal.rotation.x = it.cy * 0.6 + Math.sin(t * 0.45) * 0.05;
    it.key.position.set(2 - it.cx * 6, 3 - it.cy * 4, 5);
    const W = it.display.width, H = it.display.height;
    if (W < 2 || H < 2) return;
    renderTo(it, W, H);
    it.ctx.clearRect(0, 0, W, H);
    it.ctx.drawImage(k.canvas, 0, 0, W, H);
  });
  if (any) k.raf = requestAnimationFrame(tick);
}
function wake() { const k = getCore(); if (!k.raf) k.raf = requestAnimationFrame(tick); }

// Medalha AO VIVO dentro de um elemento (segue dedo/mouse/giroscópio).
async function mountLive(el, v, opts = {}) {
  if (!supported()) return null;
  const k = getCore();
  const display = document.createElement('canvas');
  display.className = 'mc-3d';
  el.appendChild(display);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const it = Object.assign(makeScene(k.env), { display, ctx: display.getContext('2d'), tx: 0, ty: 0, cx: 0, cy: 0, spin: opts.reveal ? Math.PI * 4 : 0, t0: performance.now(), visible: false, ready: false });
  const size = () => { const r = el.getBoundingClientRect(); display.width = Math.max(2, Math.round(r.width * dpr)); display.height = Math.max(2, Math.round(r.height * dpr)); frame(it.camera, display.width / display.height); };
  size();
  const ro = new ResizeObserver(size); ro.observe(el);
  const io = new IntersectionObserver((es) => { it.visible = es[0].isIntersecting; if (it.visible) wake(); }); io.observe(el);
  k.live.add(it);
  it.medal = await buildMedal(v, opts.quality || 'normal');
  it.scene.add(it.medal);
  it.ready = true;
  wake();
  return {
    onMove(px, py) { it.tx = (px - 0.5) * 0.9; it.ty = (py - 0.5) * 0.7; wake(); },
    dispose() { k.live.delete(it); ro.disconnect(); io.disconnect(); if (it.medal) it.medal.userData.dispose(); display.remove(); },
  };
}

// "Foto" estática da medalha 3D (para estante, imagem compartilhada, PNG).
const cache = new Map();
let queue = Promise.resolve();
async function snapshot(v, w = 600, h = 720, quality = 'high') {
  if (!supported()) return null;
  const keyStr = JSON.stringify([v.design, v.tier, v.achievement, v.placement, v.distinctions, v.event && v.event.name, v.event && v.event.date, w, h, quality]);
  if (cache.has(keyStr)) return cache.get(keyStr);
  const job = queue.then(async () => {
    const k = getCore();
    if (k.lost) return null;
    const it = makeScene(k.env);
    frame(it.camera, w / h);
    const medal = await buildMedal(v, quality);
    medal.rotation.y = -0.28; medal.rotation.x = 0.06;
    it.key.position.set(3.5, 3.5, 5);
    it.scene.add(medal);
    renderTo(it, w, h);
    const url = k.canvas.toDataURL('image/png');
    medal.userData.dispose();
    return url;
  });
  queue = job.catch(() => null);
  cache.set(keyStr, job);
  return job;
}

let support = null;
function supported() {
  if (support !== null) return support;
  try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); support = !!gl; if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } } catch (_) { support = false; }
  return support;
}

window.Medal3D = { mountLive, snapshot, supported, ready: true };
window.dispatchEvent(new Event('medal3d-ready'));
