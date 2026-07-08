import { registerService } from '../../core/services/registry';
import { cashRegisterReport } from './reports';

/** Serviços que o módulo store oferece aos outros Apps (via Core). */
export interface StoreReportsService {
  cashRegisterReport: typeof cashRegisterReport;
}

export default function setup(): void {
  registerService('store.reports', { cashRegisterReport } satisfies StoreReportsService);
}
