/**
 * Leitura e validação de NF-e (modelo 55, versão 4.00) a partir do XML.
 *
 * Responsabilidade desta camada: transformar XML → estrutura de domínio, validando o
 * que dá para validar sem banco (versão, modelo, chave, CNPJ do emitente, números,
 * produtos mínimos). A classificação contra o catálogo fica em `nfeResolve.ts`.
 *
 * Nada aqui escreve no banco — preview e commit reutilizam estas mesmas funções para
 * nunca divergir entre "o que o usuário viu" e "o que foi gravado".
 */
import { parseXml, findNode, xmlAttr, xmlChild, xmlChildren, xmlChildText, xmlNumberText } from './xmlParser';

export class NfeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NfeDocumentError';
  }
}

export interface NfeEmitente {
  cnpj: string;
  nome: string | null;
  fantasia: string | null;
}

export interface NfeDetItem {
  line: number;
  cProd: string;
  ean: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  qty: number;
  unitCostCents: number;
  totalCents: number;
}

export interface NfeParsed {
  version: string;
  accessKey: string;
  serie: string | null;
  number: string | null;
  issuedAt: string | null;
  emitente: NfeEmitente;
  totalCents: number;
  items: NfeDetItem[];
}

/** EAN/GTIN da NF-e: `SEM GTIN` e vazio viram null (campo "ausente"). */
export function normalizeEan(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t || /^sem\s*gtin$/i.test(t)) return null;
  return t;
}

/** Arredonda um número/string decimal ("7.19", "7.190000") para centavos inteiros. */
export function centsFromNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/** Dígito verificador da chave de acesso (módulo 11, pesos 2..9 da direita p/ esquerda). */
function accessKeyValid(key: string): boolean {
  if (!/^\d{44}$/.test(key)) return false;
  const base = key.slice(0, 43);
  let sum = 0;
  let weight = 2;
  for (let idx = base.length - 1; idx >= 0; idx--) {
    sum += Number(base[idx]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  const check = dv >= 10 ? 0 : dv;
  return check === Number(key[43]);
}

function requiredChildText(scope: ReturnType<typeof xmlChild>, field: string): string {
  const v = xmlChildText(scope, field);
  if (!v) throw new NfeDocumentError(`Campo obrigatório ausente: ${field}.`);
  return v;
}

export function parseNfeDocument(xml: string): NfeParsed {
  let root;
  try {
    root = parseXml(xml);
  } catch (e) {
    throw new NfeDocumentError(e instanceof Error ? `XML inválido: ${e.message}` : 'XML inválido.');
  }

  const infNFe = findNode(root, 'infNFe');
  if (!infNFe) throw new NfeDocumentError('Arquivo não parece uma NF-e: <infNFe> não encontrado.');

  const version = xmlAttr(infNFe, 'versao') ?? '';
  if (version !== '4.00') {
    throw new NfeDocumentError(`Versão da NF-e não suportada: "${version || 'ausente'}". Esperado 4.00.`);
  }

  const ide = xmlChild(infNFe, 'ide');
  if (!ide) throw new NfeDocumentError('NF-e sem o bloco <ide>.');
  const model = requiredChildText(ide, 'mod');
  if (model !== '55') {
    throw new NfeDocumentError(`Modelo não suportado: "${model}". Esperado 55.`);
  }

  // Chave de acesso: atributo Id="NFe<44 dígitos>" do infNFe.
  const idAttr = xmlAttr(infNFe, 'Id') ?? '';
  const keyDigits = idAttr.replace(/\D/g, '');
  if (keyDigits.length !== 44) throw new NfeDocumentError('Chave de acesso da NF-e ausente ou incompleta.');
  if (!accessKeyValid(keyDigits)) throw new NfeDocumentError('Chave de acesso da NF-e com dígito verificador inválido.');
  const accessKey = keyDigits;

  const emit = xmlChild(infNFe, 'emit');
  if (!emit) throw new NfeDocumentError('NF-e sem o bloco do emitente <emit>.');
  const cnpj = requiredChildText(emit, 'CNPJ').replace(/\D/g, '');
  if (!/^\d{14}$/.test(cnpj)) throw new NfeDocumentError('CNPJ do emitente inválido.');

  const serie = xmlChildText(ide, 'serie')?.trim() ?? null;
  const number = xmlChildText(ide, 'nNF')?.trim() ?? null;
  const issuedAt = xmlChildText(ide, 'dhEmi')?.trim() ?? xmlChildText(ide, 'dEmi')?.trim() ?? null;

  const dets = xmlChildren(infNFe, 'det').sort((a, b) => {
    const na = Number(xmlAttr(a, 'nItem') ?? 0);
    const nb = Number(xmlAttr(b, 'nItem') ?? 0);
    return na - nb;
  });

  const items: NfeDetItem[] = [];
  for (let idx = 0; idx < dets.length; idx++) {
    const det = dets[idx];
    const prod = xmlChild(det, 'prod');
    if (!prod) continue;
    const description = xmlChildText(prod, 'xProd')?.replace(/\s+/g, ' ').trim() ?? '';
    const cProd = xmlChildText(prod, 'cProd')?.trim() ?? '';
    if (!description || !cProd) {
      throw new NfeDocumentError(`Item ${idx + 1} da NF-e sem descrição/código do produto.`);
    }
    const qty = xmlNumberText(prod, 'qCom');
    if (qty == null || !(qty > 0)) throw new NfeDocumentError(`Item ${idx + 1}: quantidade (qCom) inválida.`);
    let unitCost = centsFromNumber(xmlNumberText(prod, 'vUnCom'));
    if (unitCost == null) {
      const vProd = xmlNumberText(prod, 'vProd');
      unitCost = vProd != null ? centsFromNumber(vProd / qty) : null;
    }
    if (unitCost == null || !(unitCost > 0)) throw new NfeDocumentError(`Item ${idx + 1}: custo unitário (vUnCom) inválido.`);
    const total = centsFromNumber(xmlNumberText(prod, 'vProd'));
    items.push({
      line: idx + 1,
      cProd,
      ean: normalizeEan(xmlChildText(prod, 'cEAN')),
      description,
      ncm: xmlChildText(prod, 'NCM')?.trim() || null,
      cfop: xmlChildText(prod, 'CFOP')?.trim() || null,
      unit: xmlChildText(prod, 'uCom')?.trim() || null,
      qty,
      unitCostCents: unitCost,
      totalCents: total ?? Math.round(unitCost * qty),
    });
  }

  if (!items.length) throw new NfeDocumentError('A NF-e não possui itens (det/prod) aproveitáveis.');

  const totalTag = xmlChild(xmlChild(infNFe, 'total'), 'ICMSTot');
  const declaredTotal = centsFromNumber(xmlNumberText(totalTag, 'vNF'));
  const totalCents = declaredTotal ?? items.reduce((acc, it) => acc + it.totalCents, 0);

  return {
    version,
    accessKey,
    serie,
    number,
    issuedAt,
    emitente: {
      cnpj,
      nome: xmlChildText(emit, 'xNome')?.trim() ?? null,
      fantasia: xmlChildText(emit, 'xFant')?.trim() ?? null,
    },
    totalCents,
    items,
  };
}
