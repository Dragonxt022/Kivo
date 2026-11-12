/**
 * Acesso SSH ao servidor do cloud, compartilhado pelos comandos `cloud:*`.
 *
 * Mesmas variáveis de ambiente do `deploy-cloud.js` para que um único conjunto de
 * configs (`KURUK_VPS_*`) sirva para deploy, backup e verificação:
 *   KURUK_VPS_HOST, KURUK_VPS_SSH_USER, KURUK_VPS_SSH_KEY,
 *   KURUK_VPS_APP_DIR (raiz do clone; o cloud fica em <app>/cloud)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

function sshConfig(env = process.env) {
  return {
    host: env.KURUK_VPS_HOST || '100.87.5.89',
    user: env.KURUK_VPS_SSH_USER || 'bruno',
    key: env.KURUK_VPS_SSH_KEY || '',
    appDir: env.KURUK_VPS_APP_DIR || '/opt/apps/kuruk-cloud',
  };
}

/** Roda um comando no servidor com a saída herdada. Devolve o exit code. */
function runRemote(remoteCommand, env = process.env) {
  const cfg = sshConfig(env);

  if (cfg.key && !fs.existsSync(cfg.key)) {
    console.error(`\n[ssh] Chave SSH não encontrada: ${cfg.key}`);
    console.error(`  Gere uma:  ssh-keygen -t ed25519 -f "${cfg.key}"`);
    console.error(`  ou rode sem KURUK_VPS_SSH_KEY para usar ~/.ssh/config e o agente.\n`);
    return 1;
  }

  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (cfg.key) args.push('-i', cfg.key);
  args.push(`${cfg.user}@${cfg.host}`, remoteCommand);

  const result = spawnSync('ssh', args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`[ssh] falha ao executar ssh: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** Comando remoto padrão: valida que o script existe no clone e executa com bash. */
function runRepoScript(name, extraArgs = '', env = process.env) {
  const cfg = sshConfig(env);
  const path = `${cfg.appDir}/scripts/${name}`;
  const remote = [
    `if [ ! -f '${path}' ]; then`,
    `  echo "[ssh] ERRO: ${path} não existe no servidor."`,
    `  echo "[ssh] Rode 'npm run kuruk cloud:deploy' para publicar os scripts."`,
    `  exit 1`,
    `fi`,
    `bash '${path}' ${extraArgs}`,
  ].join('\n');
  return runRemote(remote, env);
}

module.exports = { sshConfig, runRemote, runRepoScript };
