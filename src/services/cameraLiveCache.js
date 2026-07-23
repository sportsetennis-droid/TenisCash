const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;

const maxBytes = Math.max(
  16 * 1024 * 1024,
  Number(process.env.CAMERA_LIVE_MEMORY_CACHE_BYTES || DEFAULT_MAX_BYTES),
);
const maxAgeMs = Math.max(
  30000,
  Number(process.env.CAMERA_LIVE_MEMORY_CACHE_MS || DEFAULT_MAX_AGE_MS),
);

const entries = new Map();
let totalBytes = 0;

function cacheKey(store, camera, fileName) {
  return `${String(store || '').toUpperCase()}/${String(camera || '').toLowerCase()}/${String(fileName || '')}`;
}

function remove(key) {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.buffer.length;
  entries.delete(key);
}

function prune(now = Date.now()) {
  for (const [key, entry] of entries) {
    if (now - entry.createdAt > maxAgeMs) remove(key);
  }
  while (totalBytes > maxBytes && entries.size) {
    remove(entries.keys().next().value);
  }
}

function set(store, camera, fileName, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxBytes) return;
  const key = cacheKey(store, camera, fileName);
  remove(key);
  entries.set(key, { buffer, createdAt: Date.now() });
  totalBytes += buffer.length;
  prune();
}

function get(store, camera, fileName) {
  const key = cacheKey(store, camera, fileName);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > maxAgeMs) {
    remove(key);
    return null;
  }
  return entry.buffer;
}

module.exports = {
  get,
  set,
};
