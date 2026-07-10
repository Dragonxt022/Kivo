import type { Request } from 'express';
import { companiesDueForInvoice, generateInvoice } from './agreements';

/** Requisição sintética para ações disparadas pelo sistema (sem operador humano). */
const systemReq = {} as Request;

function runCheck(): void {
  for (const company of companiesDueForInvoice()) {
    const result = generateInvoice(systemReq, company.id);
    if (result.ok) {
      console.log(`[convenio] fatura gerada automaticamente: ${company.name} — ${result.amountCents} centavos.`);
    } else {
      console.error(`[convenio] falha ao gerar fatura automática de ${company.name}: ${result.error}`);
    }
  }
}

/**
 * Agendador do fechamento mensal de convênio: como o Katsu não fica sempre aberto,
 * não há garantia de rodar exatamente no dia de fechamento — por isso verifica no
 * boot (catch-up de qualquer fechamento perdido) e periodicamente depois.
 */
export function startAgreementScheduler(): NodeJS.Timeout {
  runCheck();
  const timer = setInterval(runCheck, 30 * 60_000);
  timer.unref();
  return timer;
}
