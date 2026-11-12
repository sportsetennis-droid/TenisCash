const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs'); const { spawn } = require('child_process');
const ff = require('ffmpeg-static'); const FPS = 30;
const OUT = process.argv[2] || 'reel.mp4'; const only = process.argv[3];
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
  const p = await b.newPage(); await p.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
  await p.goto('file:///' + path.resolve('reel.html').split(path.sep).join('/'), { waitUntil: 'networkidle0' });
  await p.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });
  const el = await p.$('#R');
  if (only) { fs.mkdirSync('prev', { recursive: true }); for (const t of only.split(',').map(Number)) { await p.evaluate(t => setT(t), t); await el.screenshot({ path: `prev/t${t.toFixed(2)}.jpg`, type: 'jpeg', quality: 80 }); } await b.close(); return; }
  const dur = await p.evaluate(() => DUR); const N = Math.round(dur * FPS);
  const f = spawn(ff, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'ignore', 'inherit'] });
  for (let i = 0; i < N; i++) { await p.evaluate(t => setT(t), i / FPS); const buf = await el.screenshot({ type: 'jpeg', quality: 92 }); if (!f.stdin.write(buf)) await new Promise(r => f.stdin.once('drain', r)); if (i % 90 === 0) console.log('frame', i, '/', N); }
  f.stdin.end(); await new Promise(r => f.on('close', r)); await b.close(); console.log('OK', OUT);
})();
