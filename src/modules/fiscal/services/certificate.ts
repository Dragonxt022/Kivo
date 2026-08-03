/**
 * Certificado digital A1 (arquivo .pfx/.p12).
 *
 * Duas responsabilidades: guardar o arquivo fora do banco e ler dele os dados que o lojista
 * precisa VER para confiar que deu certo — titular, CNPJ e validade. Sem esse retorno, subir
 * um certificado é um ato de fé: o lojista não sabe se pegou o arquivo certo, se a senha
 * está correta, nem quando vai vencer.
 *
 * O arquivo vai para `storage/fiscal/certs/`, junto da raiz de dados (mesmo padrão de
 * `productImagesDir()`), NÃO no banco: o backup copia o SQLite para a nuvem, e certificado
 * digital com senha não deve sair da máquina do contribuinte por um caminho que ele não
 * escolheu. A senha vai para o cofre (`core/secrets`).
 *
 * PKCS#12 não é lido pelo `crypto` do Node — daí `node-forge` (JS puro, sem binário nativo,
 * roda igual no Electron empacotado).
 */
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { settingsRepository } from '../../../core/repositories/SettingsRepository';
import { getSecret, setSecret } from '../../../core/secrets/service';
import { SECRET_CERT_PASSWORD } from './config';

export interface CertificateInfo {
  /** Nome do titular (CN), já sem o sufixo ":CNPJ" que a ICP-Brasil acrescenta. */
  titular: string;
  /** CNPJ extraído do CN, quando presente. */
  cnpj: string | null;
  /** ISO (YYYY-MM-DD) do fim da validade. */
  validoAte: string;
  validoDe: string;
  /** Negativo se já venceu. */
  diasRestantes: number;
  expirado: boolean;
}

export function certsDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dir = path.join(path.dirname(path.dirname(dbPath)), 'storage', 'fiscal', 'certs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseAsn1Date(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * O CN dos certificados ICP-Brasil vem como "RAZAO SOCIAL LTDA:12345678000199".
 * Separar os dois deixa a tela mostrar o nome de um jeito legível e ainda permite conferir
 * o CNPJ contra o cadastro da empresa.
 */
function splitCommonName(cn: string): { titular: string; cnpj: string | null } {
  const match = /^(.*?):(\d{11,14})$/.exec(cn.trim());
  if (!match) return { titular: cn.trim(), cnpj: null };
  return { titular: match[1].trim(), cnpj: match[2] };
}

/**
 * Abre o .pfx com a senha e devolve os dados do titular.
 * Erro de senha e arquivo inválido são indistinguíveis no PKCS#12 (a senha é o que decifra
 * o conteúdo), então a mensagem cobre os dois casos em vez de chutar um.
 */
export function readCertificate(pfx: Buffer, password: string): CertificateInfo {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = bags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!certs.length) throw new Error('O arquivo não contém nenhum certificado.');

  // Um .pfx da ICP-Brasil traz a cadeia inteira (raiz + intermediárias + o do titular).
  // O do titular é o único que não assinou ninguém — na prática, o que não é CA.
  const cert =
    certs.find((c) => {
      const basicConstraints = c.getExtension('basicConstraints') as { cA?: boolean } | undefined;
      return !basicConstraints?.cA;
    }) ?? certs[0];

  const cnField = cert.subject.getField('CN') as { value?: string } | null;
  const { titular, cnpj } = splitCommonName(cnField?.value ?? 'Titular não identificado');

  const notAfter = cert.validity.notAfter;
  const dias = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);

  return {
    titular,
    cnpj,
    validoDe: parseAsn1Date(cert.validity.notBefore),
    validoAte: parseAsn1Date(notAfter),
    diasRestantes: dias,
    expirado: dias < 0,
  };
}

/**
 * Valida, grava o arquivo e guarda a senha no cofre. Só grava depois de conseguir ler:
 * um .pfx que não abre nunca chega ao disco, então o estado salvo é sempre um estado que
 * funciona.
 */
export function storeCertificate(
  pfx: Buffer,
  password: string,
): { ok: true; info: CertificateInfo } | { ok: false; error: string } {
  let info: CertificateInfo;
  try {
    info = readCertificate(pfx, password);
  } catch {
    return {
      ok: false,
      error: 'Não foi possível abrir o certificado. Confira se a senha está correta e se o arquivo é um .pfx ou .p12 válido.',
    };
  }
  if (info.expirado) {
    return { ok: false, error: `Este certificado venceu em ${info.validoAte}. Emita um novo com o seu contador ou a autoridade certificadora.` };
  }

  const file = path.join(certsDir(), 'certificado.pfx');
  fs.writeFileSync(file, pfx, { mode: 0o600 });
  setSecret(SECRET_CERT_PASSWORD, password);
  settingsRepository.set('fiscal.cert_arquivo', file);
  settingsRepository.set('fiscal.cert_titular', info.titular);
  settingsRepository.set('fiscal.cert_validade', info.validoAte);
  return { ok: true, info };
}

/** Estado atual do certificado, relido do disco — nunca do cache em `settings`. */
export function currentCertificate(): CertificateInfo | null {
  const file = settingsRepository.get('fiscal.cert_arquivo');
  const password = getSecret(SECRET_CERT_PASSWORD);
  if (!file || !password || !fs.existsSync(file)) return null;
  try {
    return readCertificate(fs.readFileSync(file), password);
  } catch (e) {
    console.error('[fiscal] certificado gravado não pôde ser lido:', e);
    return null;
  }
}

export function removeCertificate(): void {
  const file = settingsRepository.get('fiscal.cert_arquivo');
  if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
  setSecret(SECRET_CERT_PASSWORD, '');
  settingsRepository.set('fiscal.cert_arquivo', '');
  settingsRepository.set('fiscal.cert_titular', '');
  settingsRepository.set('fiscal.cert_validade', '');
}
