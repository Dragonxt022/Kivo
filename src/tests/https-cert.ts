/**
 * HTTPS com certificado próprio (mkcert ou PFX).
 *
 * Prova o caminho que o Electron usa: encontra `https.crt` + `https.key`, extrai o
 * hostname do certificado, monta as opções do `https.createServer` e serve uma resposta.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/https-cert.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import forge from 'node-forge';
import { describeHttps, findHttpsFiles, httpsCertDir, tlsOptions } from '../core/config/httpsCert';

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function selfSigned(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'kivo.test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'kivo.test' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-https-'));
  process.env.KIVO_DB_PATH = path.join(root, 'database', 'kivo.db');
  process.env.KIVO_HTTPS_PORT = '3443';
  delete process.env.KIVO_HTTPS_CERT;
  delete process.env.KIVO_HTTPS_KEY;

  try {
    const dir = httpsCertDir();
    fs.mkdirSync(dir, { recursive: true });
    const pair = selfSigned();
    fs.writeFileSync(path.join(dir, 'https.crt'), pair.cert);
    fs.writeFileSync(path.join(dir, 'https.key'), pair.key);

    const files = findHttpsFiles();
    check('encontra https.crt + https.key', !!files && files.port === 3443);
    const described = describeHttps();
    check('lê o hostname do certificado', described.host === 'kivo.test', String(described.host));
    check('monta a URL HTTPS', described.url === 'https://kivo.test:3443/', String(described.url));
    check('não reporta erro de leitura', !described.erro, described.erro ?? '');

    const options = tlsOptions(files!);
    const server = https.createServer(options, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('kivo-https-ok');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    check('servidor HTTPS responde com o certificado', body === 'kivo-https-ok', body);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nHTTPS com certificado: TODOS OS TESTES PASSARAM' : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
