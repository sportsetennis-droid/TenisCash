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
  // The dark band moves between frames. A short luminance persistence fills
  // the underexposed rows from the immediately previous bright phase while
  // leaving chroma untouched. The low decay avoids visible motion trails.
  return '[0:v]format=yuv420p,lagfun=decay=0.60:planes=1[out]';
}

function outputPrefix(cameraNumber) {
  // A unique prefix keeps the previous playlist playable while FFmpeg
  // reconnects to a source whose HLS timeline was restarted.
  return `c${cameraNumber}${Date.now().toString(16)}_video1`;
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
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '2',
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

  // After the new playlist is live, discard files from older generations.
  // Until then the last good corrected playlist remains available to viewers.
  const cleanupTimer = setTimeout(() => {
    try {
      const playlist = fs.readFileSync(playlistPath, 'utf8');
      if (!playlist.includes(prefix)) return;
      for (const name of fs.readdirSync(outputDir)) {
        if (name.endsWith('.mp4') && !name.startsWith(prefix)) {
          fs.rmSync(path.join(outputDir, name), { force: true });
        }
      }
    } catch (_) {}
  }, 10000);
  cleanupTimer.unref();

  child.once('error', (error) => {
    console.error(`[camera-correction] camera=${cameraNumber} spawn=${error.message}`);
  });
  child.once('exit', (code, signal) => {
    children.delete(cameraNumber);
    const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' | ');
    console.warn(`[camera-correction] camera=${cameraNumber} exit=${code} signal=${signal || '-'} ${detail}`);
    schedule(cameraNumber, port, 1000);
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
