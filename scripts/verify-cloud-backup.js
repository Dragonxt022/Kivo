/**
 * `npm run kuruk cloud:backup:verify` — prova que o backup mais recente restaura.
 *
 * O dump é importado em um MySQL descartável no próprio servidor (container novo,
 * sem porta publicada) e as contagens são conferidas contra o manifesto. Produção
 * não é tocada.
 */
const { sshConfig, runRepoScript } = require('./ssh-cloud');

const cfg = sshConfig();
console.log(`[verify] testando a restauração do backup mais recente em ${cfg.user}@${cfg.host}...`);

const status = runRepoScript('restore-cloud-verify.sh');
if (status !== 0) {
  console.error(
    '\n[verify] o backup NÃO restaurou. Veja ~/backups/kuruk-cloud/restore-verify.log.',
  );
  process.exit(status);
}
console.log('[verify] restauração validada');
