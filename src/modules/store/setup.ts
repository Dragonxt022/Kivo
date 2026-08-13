import { registerService } from '../../core/services/registry';
import { cashRegisterReport } from './reports';
import { createSale, cancelSale } from './sales';
import { createQuote } from './quotes';

/** Serviços que o módulo store oferece aos outros Apps (via Core). */
export interface StoreReportsService {
  cashRegisterReport: typeof cashRegisterReport;
}
export interface StoreSalesService {
  createSale: typeof createSale;
  cancelSale: typeof cancelSale;
}
/**
 * Exposto para a fila de comandos do Kivo Web (core/sync/commands.ts) criar orçamento pedido
 * pelo celular. O Core não pode importar um módulo direto — o contrato é sempre getService.
 */
export interface StoreQuotesService {
  createQuote: typeof createQuote;
}

export default function setup(): void {
  registerService('store.reports', { cashRegisterReport } satisfies StoreReportsService);
  registerService('store.sales', { createSale, cancelSale } satisfies StoreSalesService);
  registerService('store.quotes', { createQuote } satisfies StoreQuotesService);
}
