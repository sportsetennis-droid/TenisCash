// =====================================================================
// Collage Image — monta grid 2x1 / 1x2 / 2x2 com N imagens via Sharp
// =====================================================================
// Recebe N URLs de imagem (geradas por composite, fal, ou já existentes)
// e monta um grid colado, estilo Instagram Ads multi-painel.
//
// Layouts suportados:
//   - '2x1'  → 2 painéis lado-a-lado (landscape)
//   - '1x2'  → 2 painéis empilhados (portrait)
//   - '2x2'  → 4 painéis em quadrado
//
// Cada painel pode ter um label embaixo (nome do produto, etc).
// =====================================================================

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Tamanhos finais por layout
function dimsFor(layout, aspectRatio = '1:1') {
  // aspectRatio aqui é da imagem FINAL (não dos painéis)
  const base = aspectRatio === '4:5' ? { w: 1080, h: 1350 }
             : aspectRatio === '9:16' ? { w: 1080, h: 1920 }
             : aspectRatio === '16:9' ? { w: 1920, h: 1080 }
             : { w: 1080, h: 1080 }; // 1:1 default

  if (layout === '2x1') {
    // 2 painéis side by side (preserva aspect total)
    return { totalW: base.w, totalH: base.h, cellW: Math.floor(base.w / 2), cellH: base.h, cols: 2, rows: 1 };
  }
  if (layout === '1x2') {
    return { totalW: base.w, totalH: base.h, cellW: base.w, cellH: Math.floor(base.h / 2), cols: 1, rows: 2 };
  }
  if (layout === '2x2') {
    return { totalW: base.w, totalH: base.h, cellW: Math.floor(base.w / 2), cellH: Math.floor(base.h / 2), cols: 2, rows: 2 };
  }
  throw new Error(`layout inválido: ${layout}`);
}

/**
 * Monta colagem a partir de URLs/buffers de imagem.
 *
 * @param {object} opts
 *   - panels: array de { imageUrl: string, label?: string }
 *   - layout: '2x1' | '1x2' | '2x2'
 *   - aspectRatio: '1:1' | '4:5' | '9:16' | '16:9' (default '1:1')
 *   - gap: gap entre painéis em pixels (default 8)
 *   - bgColor: cor de fundo entre painéis (default '#ffffff')
 *   - labelStyle: 'overlay' (sobre imagem) | 'belowImg' (faixa branca abaixo) | 'none'
 * @returns {Promise<Buffer>} JPEG final
 */
async function buildCollage(opts) {
  const panels = opts.panels || [];
  const layout = opts.layout || (panels.length === 4 ? '2x2' : '2x1');
  const aspectRatio = opts.aspectRatio || '1:1';
  const gap = opts.gap != null ? opts.gap : 8;
  const bgColor = opts.bgColor || '#ffffff';
  const labelStyle = opts.labelStyle || 'belowImg';

  const dims = dimsFor(layout, aspectRatio);
  const expectedPanels = dims.cols * dims.rows;
  if (panels.length < expectedPanels) {
    throw new Error(`layout ${layout} exige ${expectedPanels} painéis, recebi ${panels.length}`);
  }

  // Baixa as imagens em paralelo
  const buffers = await Promise.all(
    panels.slice(0, expectedPanels).map(p => fetchAsBuffer(p.imageUrl))
  );

  // Calcula altura efetiva da imagem por célula (deixa espaço pro label se houver)
  const hasLabels = labelStyle !== 'none' && panels.some(p => p.label);
  const labelHeight = hasLabels && labelStyle === 'belowImg' ? Math.floor(dims.cellH * 0.13) : 0;
  const imgCellH = dims.cellH - labelHeight;

  // Resize cada imagem pro tamanho da célula (image only, sem label area)
  const resized = await Promise.all(
    buffers.map(async (buf) => {
      return await sharp(buf)
        .resize(dims.cellW, imgCellH, { fit: 'cover', position: 'centre' })
        .toBuffer();
    })
  );

  // Cria canvas com cor de fundo (gap entre painéis)
  const composites = [];
  for (let i = 0; i < expectedPanels; i++) {
    const col = i % dims.cols;
    const row = Math.floor(i / dims.cols);
    const left = col * dims.cellW;
    const top = row * dims.cellH;
    composites.push({ input: resized[i], left, top });

    // Label embaixo de cada painel
    if (labelStyle === 'belowImg' && labelHeight > 0 && panels[i].label) {
      const labelText = String(panels[i].label).slice(0, 40);
      // Faixa branca + texto (SVG embedded)
      const fontSize = Math.floor(labelHeight * 0.42);
      const labelSvg = `
        <svg width="${dims.cellW}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="white"/>
          <text x="20" y="${Math.floor(labelHeight * 0.62)}" font-family="Inter, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#1d1d1f">${escapeXml(labelText)}</text>
        </svg>`;
      composites.push({
        input: Buffer.from(labelSvg),
        left,
        top: top + imgCellH,
      });
    }
  }

  // Compose final
  const finalBuf = await sharp({
    create: {
      width: dims.totalW,
      height: dims.totalH,
      channels: 3,
      background: bgColor,
    },
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();

  return finalBuf;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = {
  buildCollage,
  dimsFor,
};
