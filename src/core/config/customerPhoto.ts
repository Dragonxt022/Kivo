import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImageFormat } from '../catalog/imageValidation';

/**
 * Foto do cliente (`customers.photo_file`).
 *
 * Uma foto por CLIENTE, reaproveitada por todos os módulos: a ficha do paciente do Odonto lê
 * daqui (um paciente é sempre um cliente), o financeiro e o comercial também podem mostrar a
 * mesma imagem. Antes a foto vivia em `odonto_patients.photo_file` — um dado que não é clínico
 * e só o consultório enxergava.
 *
 * O arquivo vive no disco (`storage/customer-images`) e no banco fica só a referência. Mesmo
 * desenho do exame e da imagem de categoria: as tabelas sincronizam, base64 no banco pesaria.
 *
 * Compatibilidade: fotos antigas gravadas pelo Odonto continuam em `/uploads/odonto-patients/`.
 * `deleteCustomerPhotoByUrl` conhece os dois prefixos e apaga o arquivo certo.
 */

export const CUSTOMER_PHOTO_URL_PREFIX = '/uploads/customers/';
/** Prefixo legado (foto gravada pelo Odonto antes da migração). Continua servido. */
export const LEGACY_PATIENT_PHOTO_URL_PREFIX = '/uploads/odonto-patients/';

const EXT_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif',
};

function dataRoot(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.dirname(path.dirname(dbPath));
}

/** Relativo à raiz de dados do banco (o cwd varia num Electron empacotado). */
export function customerImagesDir(): string {
  const dir = path.join(dataRoot(), 'storage', 'customer-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Pasta legada da foto do paciente — mantida só para servir arquivos já existentes. */
export function legacyPatientPhotosDir(): string {
  const dir = path.join(dataRoot(), 'storage', 'odonto-patient-photos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Grava a foto no disco e devolve a URL que o navegador carrega. */
export function saveCustomerPhoto(buf: Buffer, format: ImageFormat): string {
  const filename = `${randomUUID()}.${EXT_BY_FORMAT[format]}`;
  fs.writeFileSync(path.join(customerImagesDir(), filename), buf);
  return `${CUSTOMER_PHOTO_URL_PREFIX}${filename}`;
}

/** Apaga o arquivo da foto anterior, seja do diretório novo ou do legado (best-effort). */
export function deleteCustomerPhotoByUrl(url: string | null | undefined): void {
  const valor = String(url ?? '');
  const base = path.basename(valor);
  if (!base) return;
  let dir: string | null = null;
  if (valor.startsWith(CUSTOMER_PHOTO_URL_PREFIX)) dir = customerImagesDir();
  else if (valor.startsWith(LEGACY_PATIENT_PHOTO_URL_PREFIX)) dir = legacyPatientPhotosDir();
  if (!dir) return;
  try {
    fs.unlinkSync(path.join(dir, base));
  } catch {
    // Já removida (backup restaurado pela metade): segue em frente.
  }
}
