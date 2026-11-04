import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';

/**
 * HTTPS opcional com certificado PRÓPRIO do lojista.
 *
 * O Kivo continua servindo HTTP na porta normal (retrocompatível com os atalhos já
 * criados). Se encontrar um certificado nesta pasta, sobe TAMBÉM um listener HTTPS —
 * é o endereço que o tablet deve abrir para o Chrome liberar PWA/notificações e o
 * Screen Wake Lock.
 *
 * Formatos aceitos em `<raiz de dados>/certificados/`:
 *   https.pfx                    (PKCS#12; senha em https.pfx.senha ou KIVO_HTTPS_PFX_PASSPHRASE)
 *   https.crt + https.key        (PEM)
 *
 * O certificado PRECISA ser válido para o hostname que o tablet usa. Certificado
 * autoassinado/CA local não é aceito de forma confiável pelo Chrome Android atual; para
 * instalar como aplicativo, use um certificado de CA pública para um domínio que resolva
 * para esta máquina (DNS local ou túnel).
 */

export const DEFAULT_HTTPS_PORT = 3443;

export interface HttpsFiles {
  pfxPath?: string;
  certPath?: string;
  keyPath?: string;
  passphrase?: string;
  port: number;
  dir: string;
}

export interface HttpsDescription {
  /** Existe arquivo de certificado na pasta? */
  configurado: boolean;
  /** O listener realmente subiu (preenchido pelo Electron via res.locals). */
  ativo: boolean;
  porta: number;
  host: string | null;
  url: string | null;
  erro: string | null;
  diretorio: string;
}

/** Raiz de dados (mesma regra de core/config/env.ts): pasta que contém database/ e storage/. */
export function kivoDataRoot(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.dirname(path.dirname(dbPath));
}

export function httpsCertDir(): string {
  return path.join(kivoDataRoot(), 'certificados');
}

function readOptional(file: string): string | undefined {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function httpsPort(): number {
  const port = Number(process.env.KIVO_HTTPS_PORT ?? DEFAULT_HTTPS_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_HTTPS_PORT;
}

/** Procura os arquivos de certificado; devolve null quando não há nada configurado. */
export function findHttpsFiles(): HttpsFiles | null {
  const dir = httpsCertDir();
  const port = httpsPort();
  const pfxPath = path.join(dir, 'https.pfx');
  if (fs.existsSync(pfxPath)) {
    return {
      pfxPath,
      passphrase:
        process.env.KIVO_HTTPS_PFX_PASSPHRASE ??
        readOptional(path.join(dir, 'https.pfx.senha')),
      port,
      dir,
    };
  }
  const certPath = path.join(dir, 'https.crt');
  const keyPath = path.join(dir, 'https.key');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, port, dir };
  }
  return null;
}

/** Opções aceitas por `https.createServer`. */
export function tlsOptions(files: HttpsFiles): {
  pfx?: Buffer;
  passphrase?: string;
  cert?: Buffer;
  key?: Buffer;
} {
  if (files.pfxPath) {
    return { pfx: fs.readFileSync(files.pfxPath), passphrase: files.passphrase };
  }
  return {
    cert: fs.readFileSync(files.certPath!),
    key: fs.readFileSync(files.keyPath!),
  };
}

/** Extrai o certificado do PFX/PEM para descobrir o hostname que ele cobre. */
function readCertificate(files: HttpsFiles): forge.pki.Certificate | null {
  try {
    if (files.pfxPath) {
      const der = forge.util.createBuffer(fs.readFileSync(files.pfxPath).toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(der),
        files.passphrase ?? '',
      );
      const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certs = bags[forge.pki.oids.certBag] ?? [];
      return certs[0]?.cert ?? null;
    }
    if (files.certPath) {
      return forge.pki.certificateFromPem(fs.readFileSync(files.certPath, 'utf8'));
    }
  } catch {
    // Certificado inválido/senha errada: o listener nem deve subir.
  }
  return null;
}

function hostFromCertificate(cert: forge.pki.Certificate | null): string | null {
  if (!cert) return null;
  const alt = cert.getExtension('subjectAltName') as
    | { altNames?: { type: number; value?: string; ip?: string }[] }
    | undefined;
  const names = alt?.altNames ?? [];
  // type 2 = dNSName; type 7 = iPAddress (node-forge usa .ip).
  const dns = names.find((n) => n.type === 2)?.value;
  if (dns) return dns;
  const ip = names.find((n) => n.type === 7)?.ip ?? names.find((n) => n.type === 7)?.value;
  if (ip) return ip;
  return cert.subject.getField('CN')?.value ?? null;
}

/** Estado para a tela de Configurações (não sobe servidor; só descreve os arquivos). */
export function describeHttps(): HttpsDescription {
  const dir = httpsCertDir();
  const port = httpsPort();
  const files = findHttpsFiles();
  if (!files) {
    return { configurado: false, ativo: false, porta: port, host: null, url: null, erro: null, diretorio: dir };
  }
  const cert = readCertificate(files);
  if (!cert) {
    return {
      configurado: true,
      ativo: false,
      porta: port,
      host: null,
      url: null,
      erro: 'Não foi possível ler o certificado. Confira o formato e a senha do .pfx.',
      diretorio: dir,
    };
  }
  const host = hostFromCertificate(cert);
  const url = host ? `https://${host}${port === 443 ? '' : `:${port}`}/` : null;
  return { configurado: true, ativo: false, porta: port, host, url, erro: null, diretorio: dir };
}

/** Cria a pasta (e um LEIA-ME) na primeira execução; não sobrescreve arquivos existentes. */
export function ensureHttpsDir(): void {
  const dir = httpsCertDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, 'LEIA-ME.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          'HTTPS com certificado próprio — Kivo',
          '',
          'Coloque nesta pasta UM dos formatos:',
          '  https.pfx                (PKCS#12; senha em https.pfx.senha ou KIVO_HTTPS_PFX_PASSPHRASE)',
          '  https.crt + https.key     (PEM)',
          '',
          `Depois reinicie o Kivo. O HTTPS sobe na porta ${httpsPort()}.`,
          '',
          'O certificado precisa ser válido para o endereço que o tablet vai abrir.',
          'Certificado autoassinado/CA local não é aceito de forma confiável pelo Chrome Android',
          'para instalar como aplicativo. Para PWA, use um certificado de CA pública para um',
          'domínio que resolva para esta máquina (DNS local ou túnel).',
          '',
        ].join('\r\n'),
        'utf8',
      );
    }
  } catch {
    // Sem permissão de escrita: o boot segue; o suporte orienta manualmente.
  }
}
