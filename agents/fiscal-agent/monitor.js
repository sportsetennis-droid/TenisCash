// =====================================================================
// TenisCash Monitor — gravacao de SEGURANCA do caixa (buffer rolante 36h)
// =====================================================================
// Roda na SESSAO DO USUARIO (tarefa no logon) — senao a captura de tela
// sai preta (isolamento de sessao do Windows). Tira um "print" da tela a
// cada poucos segundos, guarda SO as ultimas 36h e apaga o resto sozinho.
// Empresa privada, ambiente AVISADO (placa video+audio), fim de seguranca.
// Quem revisa de longe = o dono, via Supervisor (capture-list/capture-pull).
// =====================================================================
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REC_DIR = path.join(__dirname, 'rec', 'screen');
const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '5000', 10); // print a cada 5s
const RETENTION_H = parseFloat(process.env.MONITOR_RETENTION_H || '36');      // guarda 36h
const QUALITY = parseInt(process.env.MONITOR_JPEG_QUALITY || '45', 10);       // JPEG leve
const LOG_FILE = path.join(__dirname, 'monitor.log');

fs.mkdirSync(REC_DIR, { recursive: true });
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function stamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Captura TODOS os monitores (VirtualScreen) num JPEG leve, via .NET do PowerShell.
function capture(outPath) {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    "$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1;",
    "$ep=New-Object System.Drawing.Imaging.EncoderParameters 1;",
    `$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality,([long]${QUALITY}));`,
    `$bmp.Save('${outPath.replace(/\\/g, '\\\\')}',$enc,$ep);`,
    "$g.Dispose();$bmp.Dispose();",
  ].join('');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
  });
}

let cleanupTick = 0;
async function tick() {
  const out = path.join(REC_DIR, stamp() + '.jpg');
  const ok = await capture(out);
  if (!ok) log('captura falhou (tela bloqueada/sem sessao?)');

  // limpa o que passou de 36h — a cada ~12 ticks (1min) pra nao varrer toda hora
  if (++cleanupTick % 12 === 0) {
    const limit = Date.now() - RETENTION_H * 3600 * 1000;
    try {
      let removed = 0;
      for (const f of fs.readdirSync(REC_DIR)) {
        const full = path.join(REC_DIR, f);
        try { if (fs.statSync(full).mtimeMs < limit) { fs.unlinkSync(full); removed++; } } catch {}
      }
      if (removed) log('rolagem: apagados', removed, 'prints com mais de', RETENTION_H, 'h');
    } catch (e) { log('cleanup erro:', e.message); }
  }
}

log(`Monitor no ar — intervalo ${INTERVAL_MS}ms, retencao ${RETENTION_H}h, dir ${REC_DIR}`);
tick().catch(e => log('tick erro:', e.message));
setInterval(() => tick().catch(e => log('tick erro:', e.message)), INTERVAL_MS);
