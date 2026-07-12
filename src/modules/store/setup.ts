import { registerService } from '../../core/services/registry';
import { cashRegisterReport } from './reports';
import { createSale, cancelSale } from './sales';

/** Serviços que o módulo store oferece aos outros Apps (via Core). */
export interface StoreReportsService {
  cashRegisterReport: typeof cashRegisterReport;
}
export interface StoreSalesService {
  createSale: typeof createSale;
  cancelSale: typeof cancelSale;
}

export default function setup(): void {
  registerService('store.reports', { cashRegisterReport } satisfies StoreReportsService);
  registerService('store.sales', { createSale, cancelSale } satisfies StoreSalesService);
}
