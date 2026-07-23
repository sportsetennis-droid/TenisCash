const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STORE = 'LOJA05';
const RAW_ROOT = process.env.CAMERA_LIVE_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-live')
  : '/data/camera-live');
const CORRECTED_ROOT = process.env.CAMERA_CORRECTED_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-live-corrected')
  : '/data/camera-live-corrected');

const children = new Map();
const retryTimers = new Map();
let stopping = false;

function selectedCameras() {
  const configured = String(process.env.CAMERA_BAND_CORRECTION_CAMERAS || '1')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 6);
  return [...new Set(configured)];
}

function correctionFilter() {
  // The black band moves through the sensor rows. This keeps the best recent
  // light level for each row without mixing people or products across frames.
  return [
    '[0:v]format=yuv420p,split=2[base][analysis]',
    '[base]extractplanes=y+u+v[y][u][v]',
    '[analysis]extractplanes=y,scale=1:1080:flags=area,split=2[row][history]',
    '[history]lagfun=decay=0.995[reference]',
    "[row][reference]lut2=c0='clip(90+(y*100/max(x,8)-100)*0.54,90,150)'[gainrow]",
    '[gainrow]scale=1920:1080:flags=neighbor[gain]',
    "[y][gain]lut2=c0='clip(x*y/100,0,255)'[correctedy]",
    '[correctedy][u][v]mergeplanes=0x001020:yuv420p[out]',
  ].join(';');
}

function outputPrefix(cameraNumber) {
  return `c0ffee0${cameraNumber}_video1`;
}

function rawPlaylist(cameraNumber) {
  return path.join(RAW_ROOT, STORE, `loja05_camera${cameraNumber}`, 'index.m3u8');
}

function correctedDirectory(cameraNumber) {
  return path.join(CORRECTED_ROOT, STORE, `loja05_camera${cameraNumber}`);
}

function schedule(cameraNumber, port, delayMs = 5000) {
  if (stopping || retryTimers.has(cameraNumber)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(cameraNumber);
    startOne(cameraNumber, port);
  }, delayMs);
  timer.unref();
  retryTimers.set(cameraNumber, timer);
}

function startOne(cameraNumber, port) {
  if (stopping || children.has(cameraNumber)) return;
  if (!fs.existsSync(rawPlaylist(cameraNumber))) {
    schedule(cameraNumber, port);
    return;
  }

  const camera = `loja05_camera${cameraNumber}`;
  const outputDir = correctedDirectory(cameraNumber);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const prefix = outputPrefix(cameraNumber);
  const inputUrl = `http://127.0.0.1:${port}/api/live/camera/${STORE}/${camera}/index.m3u8?raw=1`;
  const playlistPath = path.join(outputDir, 'index.m3u8');
  const segmentPattern = path.join(outputDir, `${prefix}_seg%d.mp4`);

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '3000000',
    '-probesize', '3000000',
    '-i', inputUrl,
    '-filter_complex', correctionFilter(),
    '-map', '[out]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-crf', '21',
    '-maxrate', '5M',
    '-bufsize', '10M',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `${prefix}_init.mp4`,
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file',
    playlistPath,
  ];

  const child = spawn('ffmpeg', args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.set(cameraNumber, child);
  console.log(`[camera-correction] camera=${cameraNumber} pid=${child.pid} started`);

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.once('error', (error) => {
    console.error(`[camera-correction] camera=${cameraNumber} spawn=${error.message}`);
  });
  child.once('exit', (code, signal) => {
    children.delete(cameraNumber);
    const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' | ');
    console.warn(`[camera-correction] camera=${cameraNumber} exit=${code} signal=${signal || '-'} ${detail}`);
    schedule(cameraNumber, port);
  });
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  for (const child of children.values()) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  children.clear();
}

function startCameraBandCorrection(port) {
  if (process.env.CAMERA_BAND_CORRECTION !== '1') {
    console.log('[camera-correction] disabled');
    return;
  }
  const cameras = selectedCameras();
  console.log(`[camera-correction] enabled cameras=${cameras.join(',')}`);
  for (const cameraNumber of cameras) schedule(cameraNumber, port, 3000);
  process.once('SIGTERM', stopAll);
  process.once('SIGINT', stopAll);
}

module.exports = {
  CORRECTED_ROOT,
  correctionFilter,
  startCameraBandCorrection,
};
