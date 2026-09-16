import { registerService } from '../../core/services/registry';
import { demonstrativoResultado } from './report';

/**
 * Serviço do DRE exposto aos outros Apps (via Core). O Painel (overview) usa para mostrar
 * o resumo de receita/custo/resultado sem importar o módulo direto.
 */
export interface DreReportsService {
  report: typeof demonstrativoResultado;
}

export default function setup(): void {
  registerService('dre.reports', { report: demonstrativoResultado } satisfies DreReportsService);
}
