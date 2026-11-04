/**
 * Gera o certificado HTTPS local com mkcert e deixa os arquivos na pasta que o Kivo lê.
 *
 * Uso:
 *   npm run kivo https:mkcert
 *   npm run kivo https:mkcert -- kivo.minhaloja.local 10.1.1.31
 *
 * Sem argumentos, inclui localhost, 127.0.0.1 e todos os IPv4 da máquina (o tablet pode
 * abrir por qualquer um deles, desde que o certificado tenha o SAN correspondente).
 *
 * O mkcert cria uma CA local. Para o Chrome do tablet confiar, é preciso instalar o
 * `rootCA.pem` no Android (Configurações → Segurança → Instalar certificado → CA).
 * Aviso: o Chrome Android atual pode recusar CA instalada pelo usuário para instalar PWA;
 * para uma garantia de instalação/notificação, use um domínio com certificado de CA pública
 * (túnel/reverse proxy). O HTTPS local ainda serve para Wake Lock quando o Chrome aceita.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dataRoot() {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.dirname(path.dirname(dbPath));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
}

function probeMkcert() {
  return spawnSync('mkcert', ['-version'], { encoding: 'utf8', shell: true });
}

function localHosts() {
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.add(addr.address);
    }
  }
  return [...hosts];
}

const cliHosts = process.argv.slice(2).filter(Boolean);
const hosts = cliHosts.length ? cliHosts : localHosts();
const dir = path.join(dataRoot(), 'certificados');
const cert = path.join(dir, 'https.crt');
const key = path.join(dir, 'https.key');
const caFile = path.join(dir, 'rootCA.pem');

const probe = probeMkcert();
if (probe.status !== 0) {
  console.error('[https:mkcert] mkcert não encontrado no PATH.');
  console.error('Instale (Windows):  winget install FiloSottile.mkcert');
  console.error('ou baixe em:         https://github.com/FiloSottile/mkcert/releases');
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
console.log(`[https:mkcert] gerando certificado para: ${hosts.join(', ')}`);
const generated = run('mkcert', ['-cert-file', cert, '-key-file', key, ...hosts]);
if (generated.status !== 0) {
  console.error('[https:mkcert] falha ao gerar o certificado.');
  process.exit(1);
}

const caRoot = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8', shell: true });
if (caRoot.status === 0) {
  const root = caRoot.stdout.trim();
  const source = path.join(root, 'rootCA.pem');
  try {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, caFile);
      console.log(`[https:mkcert] CA copiada para: ${caFile}`);
    }
  } catch (e) {
    console.warn(`[https:mkcert] não foi possível copiar a CA: ${e.message}`);
  }
}

console.log('');
console.log('[https:mkcert] pronto:');
console.log(`  certificado: ${cert}`);
console.log(`  chave:       ${key}`);
console.log('');
console.log('Reinicie o Kivo. O HTTPS sobe na porta 3443 (ou KIVO_HTTPS_PORT).');
console.log('No tablet, abra https://<host-do-certificado>:3443 e instale o aplicativo.');
console.log(`Instale também a CA ${caFile} no Android: Configurações → Segurança →`);
console.log('Criptografia e credenciais → Instalar certificado → Certificado de CA.');
console.log('');
console.log('Se o Chrome ainda recusar a instalação, use um domínio com certificado público');
console.log('(Cloudflare Tunnel/reverse proxy): CA local não tem garantia no Android atual.');
