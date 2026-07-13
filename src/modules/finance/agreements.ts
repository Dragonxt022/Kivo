import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { receivableRepository } from './repositories/BillRepository';
import { agreementCompanyRepository, agreementChargeRepository } from './repositories/AgreementRepository';

export function periodKeyFor(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function dueDateForPeriod(periodKey: string, billingDay: number): string {
  const [year, month] = periodKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const day = Math.min(billingDay, lastDay);
  return `${periodKey}-${String(day).padStart(2, '0')}`;
}

export function chargeAgreementRaw(saleId: number, agreementCompanyId: number, amountCents: number): number {
  return agreementChargeRepository.create({
    sale_id: saleId,
    agreement_company_id: agreementCompanyId,
    amount_cents: Math.round(amountCents),
    uuid: randomUUID(),
  });
}

export function pendingTotal(companyId: number): number {
  return agreementChargeRepository.pendingTotal(companyId);
}

export function generateInvoice(
  req: Request,
  companyId: number,
  periodKey?: string,
): { ok: true; receivableId: number; amountCents: number } | { ok: false; error: string } {
  const company = agreementCompanyRepository.rawOne(
    'SELECT id, name, billing_day FROM agreement_companies WHERE id = ? AND deleted_at IS NULL',
    companyId,
  ) as { id: number; name: string; billing_day: number } | undefined;
  if (!company) return { ok: false, error: 'Empresa conveniada não encontrada.' };

  const key = periodKey ?? periodKeyFor();
  const already = receivableRepository.findByAgreementAndPeriod(companyId, key);
  if (already) return { ok: false, error: `Já existe fatura gerada para o período ${key}.` };

  const amountCents = pendingTotal(companyId);
  if (amountCents <= 0) return { ok: false, error: 'Nenhuma cobrança pendente para este convênio.' };

  let receivableId = 0;
  agreementChargeRepository.transaction(() => {
    const id = receivableRepository.create({
      description: `Fatura convênio ${company.name} — ${key}`,
      amount_cents: amountCents,
      due_date: dueDateForPeriod(key, company.billing_day),
      agreement_company_id: companyId,
      period_key: key,
      uuid: randomUUID(),
    });
    receivableId = id;
    agreementChargeRepository.invoiceAll(companyId, id);
  });
  audit(req, 'convenio_fatura_gerar', 'agreement_company', companyId, null, { receivableId, amountCents, period: key });
  return { ok: true, receivableId, amountCents };
}

export function companiesDueForInvoice(today: Date = new Date()): { id: number; name: string; billingDay: number }[] {
  const key = periodKeyFor(today);
  const companies = agreementCompanyRepository.raw(
    'SELECT id, name, billing_day AS billingDay FROM agreement_companies WHERE active = 1 AND deleted_at IS NULL',
  ) as { id: number; name: string; billingDay: number }[];
  return companies.filter((c) => {
    if (today.getDate() < c.billingDay) return false;
    const already = receivableRepository.findByAgreementAndPeriod(c.id, key);
    if (already) return false;
    return pendingTotal(c.id) > 0;
  });
}
