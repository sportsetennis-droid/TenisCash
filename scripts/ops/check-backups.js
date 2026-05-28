// =====================================================================
// scripts/ops/check-backups.js — inventário read-only dos backups locais
// =====================================================================
// Uso:
//   node scripts/ops/check-backups.js
//
// O que faz:
//   - Lista pastas em backups/ com nome db-<ISO>
//   - Mostra data, tamanho, número de arquivos
//   - Lista também arquivos _backup_*.json soltos na raiz (exports cirúrgicos)
//   - Avisa se o backup mais recente tem mais de 24h
//
// O que NÃO faz:
//   - Não acessa banco
//   - Não chama rede
//   - Não escreve nada
//   - Não compacta
//   - Não apaga
//   - Não cria backup
// =====================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKUPS_DIR = path.join(ROOT, 'backups');

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function totalSize(dir) {
  let total = 0;
  let count = 0;
  try {
    const items = fs.readdirSync(dir);
    for (const f of items) {
      const stat = fs.statSync(path.join(dir, f));
      if (stat.isFile()) {
        total += stat.size;
        count++;
      }
    }
  } catch {}
  return { total, count };
}

function hoursSince(date) {
  return (Date.now() - date.getTime()) / 1000 / 3600;
}

function main() {
  console.log('=== Inventário de backups — TenisCash ===');
  console.log('Data atual: ' + new Date().toISOString());
  console.log('Pasta: ' + BACKUPS_DIR);
  console.log('');

  if (!fs.existsSync(BACKUPS_DIR)) {
    console.log('❌ Pasta backups/ NÃO EXISTE.');
    console.log('Crie com: mkdir backups');
    return;
  }

  // 1) Pastas db-*
  const entries = fs.readdirSync(BACKUPS_DIR);
  const folders = entries
    .filter((e) => {
      try {
        return fs.statSync(path.join(BACKUPS_DIR, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => {
      const full = path.join(BACKUPS_DIR, e);
      const stat = fs.statSync(full);
      const { total, count } = totalSize(full);
      return { name: e, path: full, mtime: stat.mtime, size: total, files: count };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (folders.length === 0) {
    console.log('⚠️  Nenhum backup em pastas db-* encontrado.');
  } else {
    console.log('--- Backups em pastas db-<timestamp> ---');
    for (const f of folders) {
      const hrs = hoursSince(f.mtime);
      const idade = hrs < 24 ? `${hrs.toFixed(1)}h atrás` : `${(hrs / 24).toFixed(1)}d atrás`;
      console.log(`  ${f.name.padEnd(35)}  ${idade.padStart(12)}  ${f.files.toString().padStart(4)} arquivos  ${fmtSize(f.size).padStart(10)}`);
    }
  }
  console.log('');

  // 2) Arquivos _backup_*.json soltos na raiz
  const rootBackups = fs
    .readdirSync(ROOT)
    .filter((f) => /^_backup_.+\.json$/i.test(f))
    .map((f) => {
      const full = path.join(ROOT, f);
      const stat = fs.statSync(full);
      return { name: f, mtime: stat.mtime, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (rootBackups.length === 0) {
    console.log('--- Sem _backup_*.json soltos na raiz ---');
  } else {
    console.log('--- _backup_*.json (exports cirúrgicos na raiz) ---');
    for (const f of rootBackups) {
      const hrs = hoursSince(f.mtime);
      const idade = hrs < 24 ? `${hrs.toFixed(1)}h atrás` : `${(hrs / 24).toFixed(1)}d atrás`;
      console.log(`  ${f.name.padEnd(50)}  ${idade.padStart(12)}  ${fmtSize(f.size).padStart(10)}`);
    }
  }
  console.log('');

  // 3) Aviso de idade
  if (folders.length > 0) {
    const mais_recente = folders[0];
    const hrs = hoursSince(mais_recente.mtime);
    console.log('=== Status ===');
    if (hrs < 24) {
      console.log('✅ Backup mais recente tem ' + hrs.toFixed(1) + 'h. OK.');
    } else if (hrs < 48) {
      console.log('🟡 Backup mais recente tem ' + (hrs / 24).toFixed(1) + 'd. Atenção: passou de 24h.');
    } else {
      console.log('🔴 Backup mais recente tem ' + (hrs / 24).toFixed(1) + 'd. CRÍTICO: backup desatualizado.');
    }
  } else {
    console.log('🔴 NENHUM backup encontrado.');
  }
  console.log('');

  // 4) Recomendação rápida
  console.log('=== Próximos passos ===');
  console.log('- Confirmar backup automático Railway (painel → Postgres → Backups)');
  console.log('- Para backup local manual: pg_dump "$DATABASE_URL" > backups/db-$(date -u +%Y-%m-%dT%H-%M-%S).sql');
  console.log('- Detalhes em docs/BACKUP_OPERACIONAL.md');
}

main();
