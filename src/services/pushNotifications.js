// =====================================================================
// Web Push Notifications — VAPID + delivery
// =====================================================================
// Lazy-load web-push pra não quebrar boot se a lib ainda não instalou.
// Geração das chaves VAPID é automática na primeira execução e fica
// salva em Config (chave "vapid_public" + "vapid_private").
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let webpush = null;
let vapidReady = false;

async function loadWebpush() {
  if (!webpush) {
    try { webpush = require('web-push'); }
    catch (e) { console.warn('[push] web-push não instalado:', e.message); return null; }
  }
  return webpush;
}

async function ensureVapidKeys() {
  if (vapidReady) return true;
  const wp = await loadWebpush();
  if (!wp) return false;

  let pub = await prisma.config.findUnique({ where: { key: 'vapid_public' } }).catch(() => null);
  let priv = await prisma.config.findUnique({ where: { key: 'vapid_private' } }).catch(() => null);

  if (!pub || !priv) {
    const keys = wp.generateVAPIDKeys();
    await prisma.config.upsert({
      where: { key: 'vapid_public' },
      update: { value: keys.publicKey },
      create: { id: 'cfg_vapid_pub', key: 'vapid_public', value: keys.publicKey },
    });
    await prisma.config.upsert({
      where: { key: 'vapid_private' },
      update: { value: keys.privateKey },
      create: { id: 'cfg_vapid_priv', key: 'vapid_private', value: keys.privateKey },
    });
    pub = { value: keys.publicKey };
    priv = { value: keys.privateKey };
    console.log('[push] VAPID keys geradas e salvas no banco');
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:bernardo_douglas@icloud.com';
  wp.setVapidDetails(subject, pub.value, priv.value);
  vapidReady = true;
  return true;
}

async function getPublicKey() {
  await ensureVapidKeys();
  const pub = await prisma.config.findUnique({ where: { key: 'vapid_public' } });
  return pub?.value || null;
}

async function sendToUser(userId, payload) {
  const ok = await ensureVapidKeys();
  if (!ok) return { sent: 0, failed: 0 };
  const wp = await loadWebpush();

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.authKey } },
        JSON.stringify(payload)
      );
      sent++;
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    } catch (err) {
      failed++;
      // 410 Gone = subscription cancelada pelo browser → apaga
      if (err.statusCode === 410 || err.statusCode === 404) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      }
    }
  }
  return { sent, failed };
}

module.exports = { ensureVapidKeys, getPublicKey, sendToUser };
