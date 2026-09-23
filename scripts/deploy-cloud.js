/**
 * Deploy do cloud/ (Kivo Web) para a VPS — versão MULTIPLATAFORMA.
 *
 * O `deploy-cloud.sh` só roda em Linux/macOS/Git Bash; no Windows o `bash` do PATH cai no
 * WSL (sem distro) e o comando falha. Este script faz o mesmo via Node + `ssh`, então
 * `npm run kivo cloud:deploy` funciona também no PowerShell.
 *
 * Config por variável de ambiente (ver cloud/.env.example):
 *   KIVO_VPS_HOST, KIVO_VPS_SSH_USER, KIVO_VPS_SITE_USER, KIVO_VPS_CLOUD_DIR,
 *   KIVO_VPS_SSH_KEY, KIVO_VPS_PM2_NAME, KIVO_CLOUD_HEALTH_URL
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = process.env.KIVO_VPS_HOST || '187.77.251.231';
const SSH_USER = process.env.KIVO_VPS_SSH_USER || 'root';
const SITE_USER = process.env.KIVO_VPS_SITE_USER || 'buscamais-kivo';
const CLOUD_DIR = process.env.KIVO_VPS_CLOUD_DIR || `/home/${SITE_USER}/htdocs/kivo.buscamais.org/cloud`;
const KEY = process.env.KIVO_VPS_SSH_KEY || path.join(os.homedir(), '.ssh', 'kivo_vps_deploy');
const HEALTH_URL = process.env.KIVO_CLOUD_HEALTH_URL || 'https://kivo.buscamais.org/api/health';
const PM2_NAME = process.env.KIVO_VPS_PM2_NAME || 'kivo-cloud';

if (!fs.existsSync(KEY)) {
  console.error(`\n[deploy] Chave SSH não encontrada: ${KEY}`);
  console.error('  Gere uma:  ssh-keygen -t ed25519 -f "' + KEY + '"');
  console.error('  Copie a pública:  ssh-copy-id -i "' + KEY + '.pub" ' + SSH_USER + '@' + HOST);
  console.error('  (ou defina KIVO_VPS_SSH_KEY apontando para a chave correta)\n');
  process.exit(1);
}

// Script remoto (roda no bash da VPS). `set -e` dentro do bloco: uma migration que falha
// interrompe o deploy em vez de seguir para o restart.
const remote = [
  'set -euo pipefail',
  `cd ${CLOUD_DIR}`,
  '# --ff-only: se a VPS tiver commit local, o deploy FALHA em vez de criar merge silencioso.',
  'git pull --ff-only origin main',
  '# --include=dev: o build (tsc) e as migrations (tsx) dependem de devDependencies.',
  'npm install --include=dev',
  'npm run build',
  'if [ ! -f ./.env ]; then echo "[deploy] ERRO: falta o arquivo .env em ' + CLOUD_DIR + '"; exit 1; fi',
  'set -a',
  '. ./.env',
  'set +a',
  'npm run migrate',
  'npm run seed:themes',
  'if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then pm2 install pm2-logrotate; fi',
  'pm2 set pm2-logrotate:max_size 50M',
  'pm2 set pm2-logrotate:retain 14',
  'pm2 set pm2-logrotate:compress true',
  'pm2 set pm2-logrotate:workerInterval 60',
  `pm2 restart ${PM2_NAME}`,
  'sleep 2',
  `pm2 show ${PM2_NAME} | grep status`,
].join('\n');

console.log(`[deploy] conectando em ${SSH_USER}@${HOST}...`);
try {
  execFileSync(
    'ssh',
    ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', `${SSH_USER}@${HOST}`, remote],
    { stdio: 'inherit' },
  );
} catch (e) {
  console.error('\n[deploy] A conexão/execução remota falhou. Veja a saída acima.');
  process.exit(1);
}

console.log(`\n[deploy] verificando ${HEALTH_URL}...`);
(async () => {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.text();
    console.log(`[deploy] OK — ${body.slice(0, 120)}`);
  } catch (e) {
    console.error(`[deploy] health check falhou: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();
