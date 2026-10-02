import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { getPool } from './db';
import { affiliateDiscountFor } from './affiliates';

/**
 * Contratos do Kivo Cloud.
 *
 * O caminho comercial é: instala e ativa o teste → 15 dias de uso → contrato assinado. O
 * contrato guarda o que foi combinado (número, prazo em meses, valor mensal, PDF assinado) e
 * gera o **bloco de cobranças** de uma vez — 12 meses viram 12 parcelas mensais, cada uma com
 * seu vencimento e com `extends_days`, para o pagamento estender a licença sozinho.
 *
 * Nada aqui reimplementa dinheiro: as parcelas são cobranças comuns (`charges`), então
 * Pix/boleto/cartão, webhook, comissão de afiliado e baixa continuam sendo os mesmos caminhos
 * já testados. O contrato só amarra as parcelas umas às outras.
 */

export const CONTRACT_STORAGE_DIR = path.resolve(__dirname, '..', '..', 'storage', 'contracts');

/** 5 MB: acima disso o corpo JSON (base64) passa do limite de 8mb do express. */
export const MAX_CONTRACT_PDF_BYTES = 5 * 1024 * 1024;

export interface ContractRow {
  id: number;
  company_uuid: string;
  contract_number: string;
  title: string | null;
  status: 'ativo' | 'concluido' | 'cancelado';
  first_due_date: string;
  months: number;
  monthly_amount_cents: number;
  extends_days: number;
  payer_email: string | null;
  signed_on: string | null;
  document_name: string | null;
  document_file: string | null;
  document_bytes: number | null;
  notes: string | null;
  created_at: string;
}

/** Contrato com os números que a tela mostra (progresso das parcelas). */
export interface ContractSummary extends ContractRow {
  company_name?: string;
  parcelas: number;
  pagas: number;
  pago_cents: number;
  aberto_cents: number;
  proximo_vencimento: string | null;
  vencidas: number;
}

const CONTRACT_COLS = `c.id, c.company_uuid, c.contract_number, c.title, c.status, c.first_due_date,
  c.months, c.monthly_amount_cents, c.extends_days, c.payer_email, c.signed_on,
  c.document_name, c.document_file, c.document_bytes, c.notes, c.created_at`;

const SUMMARY_COLS = `${CONTRACT_COLS},
  (SELECT COUNT(*) FROM charges ch WHERE ch.contract_id = c.id) AS parcelas,
  (SELECT COUNT(*) FROM charges ch WHERE ch.contract_id = c.id AND ch.status = 'paga') AS pagas,
  (SELECT COALESCE(SUM(ch.amount_cents), 0) FROM charges ch WHERE ch.contract_id = c.id AND ch.status = 'paga') AS pago_cents,
  (SELECT COALESCE(SUM(ch.amount_cents), 0) FROM charges ch WHERE ch.contract_id = c.id AND ch.status = 'pendente') AS aberto_cents,
  (SELECT MIN(ch.due_date) FROM charges ch WHERE ch.contract_id = c.id AND ch.status = 'pendente') AS proximo_vencimento,
  (SELECT COUNT(*) FROM charges ch WHERE ch.contract_id = c.id AND ch.status = 'pendente' AND ch.due_date < CURDATE()) AS vencidas`;

// ─────────────────────────────── Números e datas ───────────────────────────────

/**
 * Próximo número no formato `KIVO-<ano>-<0000>`. A sequência vive em tabela própria e é
 * incrementada dentro da transação do contrato: dois cadastros ao mesmo tempo não repetem.
 */
export async function nextContractNumber(conn: PoolConnection, ano: number): Promise<string> {
  await conn.query(
    'INSERT INTO contract_number_seq (ano, ultimo) VALUES (?, 1) ON DUPLICATE KEY UPDATE ultimo = ultimo + 1',
    [ano],
  );
  const [rows] = await conn.query('SELECT ultimo FROM contract_number_seq WHERE ano = ?', [ano]);
  const ultimo = Number((rows as { ultimo: number }[])[0]?.ultimo ?? 1);
  return `KIVO-${ano}-${String(ultimo).padStart(4, '0')}`;
}

/**
 * Vencimentos das parcelas: a primeira é a data informada e as seguintes caem no mesmo dia dos
 * meses seguintes. Dia 31 em mês de 30 vira o último dia do mês (e 29/02 vira 28/02 em ano
 * comum) — cobrança não pode ficar sem vencimento.
 */
export function parcelDates(firstDueDate: string, months: number): string[] {
  const [ano0, mes0, dia0] = firstDueDate.split('-').map(Number);
  const datas: string[] = [];
  for (let i = 0; i < months; i++) {
    const ano = ano0 + Math.floor((mes0 - 1 + i) / 12);
    const mes = ((mes0 - 1 + i) % 12) + 1;
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    datas.push(`${ano}-${String(mes).padStart(2, '0')}-${String(Math.min(dia0, ultimoDia)).padStart(2, '0')}`);
  }
  return datas;
}

/** Data no formato YYYY-MM-DD, validada. Devolve null quando não é uma data de verdade. */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : s;
}

// ─────────────────────────────── Criação ───────────────────────────────

export interface NewContractInput {
  companyUuid: string;
  title?: string | null;
  months: number;
  monthlyAmountCents: number;
  firstDueDate: string;
  extendsDays?: number;
  payerEmail?: string | null;
  signedOn?: string | null;
  notes?: string | null;
  /** Número digitado à mão; em branco gera KIVO-<ano>-<seq>. */
  contractNumber?: string | null;
}

export interface CreatedContract {
  id: number;
  contractNumber: string;
  months: number;
  monthlyAmountCents: number;
  firstDueDate: string;
  lastDueDate: string;
  chargeIds: number[];
  totalCents: number;
}

/** Descrição da parcela: é o que o cliente lê na tela de Cobranças do programa. */
export function installmentDescription(title: string | null, numero: number, total: number): string {
  const base = (title ?? '').trim() || 'Assinatura Kivo';
  return `${base} — parcela ${numero}/${total}`;
}

/**
 * Cria o contrato e o bloco de parcelas numa transação: ou sai o contrato com todas as
 * cobranças, ou não sai nada (contrato sem cobrança é pior que erro na tela).
 */
export async function createContractWithCharges(input: NewContractInput): Promise<CreatedContract> {
  const months = Math.max(1, Math.min(120, Math.round(input.months)));
  const monthly = Math.max(1, Math.round(input.monthlyAmountCents));
  const extendsDays = Math.max(0, Math.min(3650, Math.round(input.extendsDays ?? 30)));
  const datas = parcelDates(input.firstDueDate, months);
  // Desconto de indicação: uma leitura só, aplicada a todas as parcelas.
  const { pct, discountCents } = await affiliateDiscountFor(input.companyUuid, monthly);

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const numero = (input.contractNumber ?? '').trim()
      || await nextContractNumber(conn, Number(input.firstDueDate.slice(0, 4)));

    const [ins] = await conn.query(
      `INSERT INTO contracts
         (company_uuid, contract_number, title, first_due_date, months, monthly_amount_cents,
          extends_days, payer_email, signed_on, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyUuid, numero, (input.title ?? '').trim() || null, input.firstDueDate, months, monthly,
        extendsDays, (input.payerEmail ?? '').trim() || null, input.signedOn ?? null,
        (input.notes ?? '').trim() || null,
      ],
    );
    const contractId = Number((ins as { insertId: number }).insertId);

    const chargeIds: number[] = [];
    for (let i = 1; i <= months; i++) {
      const [c] = await conn.query(
        `INSERT INTO charges
           (company_uuid, description, amount_cents, original_amount_cents, discount_pct, discount_cents,
            due_date, payer_email, extends_days, public_token, contract_id, installment_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.companyUuid,
          installmentDescription(input.title ?? null, i, months),
          monthly - discountCents,
          monthly,
          pct,
          discountCents,
          datas[i - 1],
          (input.payerEmail ?? '').trim() || null,
          extendsDays,
          randomUUID(),
          contractId,
          i,
        ],
      );
      chargeIds.push(Number((c as { insertId: number }).insertId));
    }

    await conn.commit();
    return {
      id: contractId,
      contractNumber: numero,
      months,
      monthlyAmountCents: monthly,
      firstDueDate: datas[0],
      lastDueDate: datas[datas.length - 1],
      chargeIds,
      totalCents: (monthly - discountCents) * months,
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Completa o bloco: gera as parcelas que faltam (por número) sem tocar nas que já existem.
 * Serve para depois de apagar uma parcela errada e para contrato antigo que ficou pela metade.
 */
export async function generateMissingCharges(contractId: number): Promise<number[]> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM contracts WHERE id = ? FOR UPDATE', [contractId]);
    const contrato = (rows as ContractRow[])[0];
    if (!contrato) {
      await conn.rollback();
      return [];
    }
    if (contrato.status === 'cancelado') {
      await conn.rollback();
      return [];
    }

    const [existentes] = await conn.query(
      'SELECT installment_number FROM charges WHERE contract_id = ? AND installment_number IS NOT NULL',
      [contractId],
    );
    const jaTem = new Set((existentes as { installment_number: number }[]).map((r) => Number(r.installment_number)));
    const datas = parcelDates(String(contrato.first_due_date).slice(0, 10), Number(contrato.months));
    const { pct, discountCents } = await affiliateDiscountFor(contrato.company_uuid, Number(contrato.monthly_amount_cents));

    const criadas: number[] = [];
    for (let i = 1; i <= Number(contrato.months); i++) {
      if (jaTem.has(i)) continue;
      const [c] = await conn.query(
        `INSERT INTO charges
           (company_uuid, description, amount_cents, original_amount_cents, discount_pct, discount_cents,
            due_date, payer_email, extends_days, public_token, contract_id, installment_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contrato.company_uuid,
          installmentDescription(contrato.title, i, Number(contrato.months)),
          Number(contrato.monthly_amount_cents) - discountCents,
          Number(contrato.monthly_amount_cents),
          pct,
          discountCents,
          datas[i - 1],
          contrato.payer_email,
          Number(contrato.extends_days),
          randomUUID(),
          contractId,
          i,
        ],
      );
      criadas.push(Number((c as { insertId: number }).insertId));
    }
    await conn.commit();
    return criadas;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────── Consultas ───────────────────────────────

export async function listContracts(filtro: { companyUuid?: string; status?: string } = {}): Promise<ContractSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filtro.companyUuid) {
    where.push('c.company_uuid = ?');
    params.push(filtro.companyUuid);
  }
  if (filtro.status && ['ativo', 'concluido', 'cancelado'].includes(filtro.status)) {
    where.push('c.status = ?');
    params.push(filtro.status);
  }
  const [rows] = await getPool().query(
    `SELECT ${SUMMARY_COLS}, co.name AS company_name
       FROM contracts c
       JOIN companies co ON co.company_uuid = c.company_uuid
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.status = 'ativo' DESC, c.created_at DESC`,
    params,
  );
  return rows as ContractSummary[];
}

export async function getContract(id: number, companyUuid?: string): Promise<ContractRow | null> {
  const [rows] = await getPool().query(
    `SELECT ${CONTRACT_COLS} FROM contracts c WHERE c.id = ?${companyUuid ? ' AND c.company_uuid = ?' : ''}`,
    companyUuid ? [id, companyUuid] : [id],
  );
  return ((rows as ContractRow[])[0] ?? null) as ContractRow | null;
}

export async function getContractSummary(id: number): Promise<ContractSummary | null> {
  const [rows] = await getPool().query(
    `SELECT ${SUMMARY_COLS}, co.name AS company_name
       FROM contracts c JOIN companies co ON co.company_uuid = c.company_uuid WHERE c.id = ?`,
    [id],
  );
  return ((rows as ContractSummary[])[0] ?? null) as ContractSummary | null;
}

/** As parcelas do contrato, na ordem — é o bloco que a tela mostra. */
export async function contractCharges(contractId: number): Promise<
  { id: number; installment_number: number | null; description: string; amount_cents: number; due_date: string; status: string; paid_at: string | null; mp_method: string | null; mp_status: string | null; public_token: string | null }[]
> {
  const [rows] = await getPool().query(
    `SELECT id, installment_number, description, amount_cents, due_date, status, paid_at,
            mp_method, mp_status, public_token
       FROM charges WHERE contract_id = ? ORDER BY installment_number IS NULL, installment_number, due_date`,
    [contractId],
  );
  return rows as never;
}

// ─────────────────────────────── Ciclo de vida ───────────────────────────────

/**
 * Cancela o contrato e as parcelas ainda em aberto. Parcela paga é dinheiro que entrou: fica
 * como está (e a comissão do afiliado também).
 */
export async function cancelContract(contractId: number): Promise<{ canceladas: number }> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [c] = await conn.query(
      "UPDATE charges SET status = 'cancelada' WHERE contract_id = ? AND status = 'pendente'",
      [contractId],
    );
    await conn.query("UPDATE contracts SET status = 'cancelado' WHERE id = ?", [contractId]);
    await conn.commit();
    return { canceladas: Number((c as { affectedRows: number }).affectedRows) };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function setContractStatus(contractId: number, status: 'ativo' | 'concluido' | 'cancelado'): Promise<void> {
  await getPool().query('UPDATE contracts SET status = ? WHERE id = ?', [status, contractId]);
}

/**
 * Apaga o contrato de vez — só quando NENHUMA parcela foi paga. Contrato com pagamento é
 * histórico financeiro: o caminho é cancelar, não apagar.
 */
export async function deleteContract(contractId: number): Promise<{ ok: boolean; motivo?: string }> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS pagas FROM charges WHERE contract_id = ? AND status = 'paga'",
      [contractId],
    );
    if (Number((rows as { pagas: number }[])[0]?.pagas ?? 0) > 0) {
      await conn.rollback();
      return { ok: false, motivo: 'Este contrato já tem parcela paga — cancele em vez de apagar.' };
    }
    await conn.query('DELETE FROM charges WHERE contract_id = ?', [contractId]);
    await conn.query('DELETE FROM contracts WHERE id = ?', [contractId]);
    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────── Documento (PDF) ───────────────────────────────

export interface DocumentUpload {
  name: string;
  /** Conteúdo do PDF em base64 (o painel manda assim; o cloud não usa multipart). */
  base64: string;
}

export function sanitizeDocumentName(name: string): string {
  const limpo = String(name ?? '').replace(/[\r\n"\\/]/g, '').trim().slice(0, 200);
  return limpo || 'contrato.pdf';
}

/**
 * Valida e grava o PDF do contrato. Confere a assinatura `%PDF-` de verdade: extensão de
 * arquivo não é prova de nada, e um anexo que não abre é pior que nenhum.
 */
export async function saveContractDocument(
  contractId: number,
  upload: DocumentUpload,
): Promise<{ ok: true; name: string; bytes: number } | { ok: false; error: string }> {
  const contrato = await getContract(contractId);
  if (!contrato) return { ok: false, error: 'Contrato não encontrado.' };

  const base64 = String(upload.base64 ?? '').replace(/^data:application\/pdf;base64,/, '').trim();
  if (!base64) return { ok: false, error: 'Nenhum arquivo recebido.' };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, error: 'Arquivo inválido.' };
  }
  if (buffer.length === 0) return { ok: false, error: 'Arquivo vazio.' };
  if (buffer.length > MAX_CONTRACT_PDF_BYTES) {
    return { ok: false, error: `O PDF tem ${(buffer.length / 1048576).toFixed(1)} MB — o limite é 5 MB.` };
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, error: 'O arquivo enviado não é um PDF.' };
  }

  const sha = createHash('sha256').update(buffer).digest('hex');
  const nome = `${contrato.contract_number}-${sha.slice(0, 8)}.pdf`;
  fs.mkdirSync(CONTRACT_STORAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTRACT_STORAGE_DIR, nome), buffer);

  // Troca de anexo: o arquivo antigo não fica ocupando disco para sempre.
  if (contrato.document_file && contrato.document_file !== nome) {
    fs.rmSync(path.join(CONTRACT_STORAGE_DIR, contrato.document_file), { force: true });
  }

  await getPool().query(
    'UPDATE contracts SET document_name = ?, document_file = ?, document_bytes = ?, document_sha256 = ? WHERE id = ?',
    [sanitizeDocumentName(upload.name), nome, buffer.length, sha, contractId],
  );
  return { ok: true, name: sanitizeDocumentName(upload.name), bytes: buffer.length };
}

export function contractDocumentPath(contrato: ContractRow): string | null {
  if (!contrato.document_file) return null;
  const caminho = path.join(CONTRACT_STORAGE_DIR, contrato.document_file);
  return fs.existsSync(caminho) ? caminho : null;
}

export async function removeContractDocument(contractId: number): Promise<void> {
  const contrato = await getContract(contractId);
  if (contrato?.document_file) fs.rmSync(path.join(CONTRACT_STORAGE_DIR, contrato.document_file), { force: true });
  await getPool().query(
    'UPDATE contracts SET document_name = NULL, document_file = NULL, document_bytes = NULL, document_sha256 = NULL WHERE id = ?',
    [contractId],
  );
}

/** Resumo em uma linha para as telas: "3/12 pagas · próximo 10/12/2026". */
export function contractProgressLabel(c: ContractSummary): string {
  const partes = [`${Number(c.pagas)}/${Number(c.parcelas)} pagas`];
  if (c.proximo_vencimento) partes.push(`próximo ${String(c.proximo_vencimento).slice(0, 10).split('-').reverse().join('/')}`);
  if (Number(c.vencidas) > 0) partes.push(`${c.vencidas} vencida(s)`);
  return partes.join(' · ');
}
