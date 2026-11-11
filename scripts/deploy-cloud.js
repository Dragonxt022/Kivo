/**
 * Deploy do cloud/ (Kuruk Web) para a VPS — versão MULTIPLATAFORMA.
 *
 * O `deploy-cloud.sh` só roda em Linux/macOS/Git Bash; no Windows o `bash` do PATH cai no
 * WSL (sem distro) e o comando falha. Este script faz o mesmo via Node + `ssh`, então
 * `npm run kuruk cloud:deploy` funciona também no PowerShell.
 *
 * Config por variável de ambiente (ver cloud/.env.example):
 *   KURUK_VPS_HOST, KURUK_VPS_SSH_USER, KURUK_VPS_CLOUD_DIR,
 *   KURUK_VPS_SSH_KEY (opcional), KURUK_VPS_PM2_NAME, KURUK_VPS_PM2_USER,
 *   KURUK_CLOUD_HEALTH_URL
 *
 * O diretório remoto precisa ser um clone deste repositório (o `cloud/` é um
 * pacote separado dentro do monorepo). No servidor OLD o padrão é
 * `/opt/apps/kuruk-cloud/cloud`, com PM2 rodando como o usuário `nodeapps`.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const HOST = process.env.KURUK_VPS_HOST || '100.87.5.89';
const SSH_USER = process.env.KURUK_VPS_SSH_USER || 'bruno';
const CLOUD_DIR = process.env.KURUK_VPS_CLOUD_DIR || '/opt/apps/kuruk-cloud/cloud';
const KEY = process.env.KURUK_VPS_SSH_KEY || '';
const HEALTH_URL = process.env.KURUK_CLOUD_HEALTH_URL || 'https://kuruk.com.br/api/health';
const PM2_NAME = process.env.KURUK_VPS_PM2_NAME || 'kuruk-cloud';
// No servidor OLD o PM2 é gerenciado pelo usuário nodeapps. Deixe vazio para
// rodar `pm2` diretamente (ex.: quando o deploy já é feito como esse usuário).
const PM2_USER = process.env.KURUK_VPS_PM2_USER ?? 'nodeapps';
const PM2 = PM2_USER ? `sudo -iu ${PM2_USER} pm2` : 'pm2';

if (KEY && !fs.existsSync(KEY)) {
  console.error(`\n[deploy] Chave SSH não encontrada: ${KEY}`);
  console.error('  Gere uma:  ssh-keygen -t ed25519 -f "' + KEY + '"');
  console.error('  Copie a pública:  ssh-copy-id -i "' + KEY + '.pub" ' + SSH_USER + '@' + HOST);
  console.error('  (ou defina KURUK_VPS_SSH_KEY; sem ela o ssh usa ~/.ssh/config e o agente)\n');
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
  `if ! ${PM2} describe pm2-logrotate >/dev/null 2>&1; then ${PM2} install pm2-logrotate; fi`,
  `${PM2} set pm2-logrotate:max_size 50M`,
  `${PM2} set pm2-logrotate:retain 14`,
  `${PM2} set pm2-logrotate:compress true`,
  `${PM2} set pm2-logrotate:workerInterval 60`,
  `${PM2} restart ${PM2_NAME}`,
  'sleep 2',
  `${PM2} show ${PM2_NAME} | grep status`,
].join('\n');

const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
if (KEY) sshArgs.push('-i', KEY);
sshArgs.push(`${SSH_USER}@${HOST}`, remote);

console.log(`[deploy] conectando em ${SSH_USER}@${HOST}...`);
try {
  execFileSync('ssh', sshArgs, { stdio: 'inherit' });
} catch {
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
