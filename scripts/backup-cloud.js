/**
 * `npm run kuruk cloud:backup` — gera um restore point do cloud no servidor:
 * banco + storage + segredos + configs, com checksums e cópia offsite.
 *
 * O trabalho pesado roda no servidor (`scripts/backup-cloud.sh`); aqui só há o
 * transporte por SSH. Assim o mesmo comando roda no Windows e no Linux.
 */
const { sshConfig, runRepoScript } = require('./ssh-cloud');

const cfg = sshConfig();
console.log(`[backup] executando backup em ${cfg.user}@${cfg.host}...`);

const status = runRepoScript('backup-cloud.sh');
if (status !== 0) {
  console.error('\n[backup] falhou. Veja o log em ~/backups/kuruk-cloud/backup.log no servidor.');
  process.exit(status);
}
console.log('[backup] OK');
