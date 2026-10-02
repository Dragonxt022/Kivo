import { registerService } from '../../core/services/registry';
import { odontoPatientsService, type OdontoPatientsService } from './patients';
import { odontoProfessionalsService, type OdontoProfessionalsService } from './professionals';

/**
 * Setup do módulo odonto — roda no boot, depois das migrations e antes de qualquer
 * requisição. Publica no Core só o que outros módulos precisam: a agenda (próxima fase)
 * vai escolher paciente e profissional por aqui, sem importar repositório alheio.
 */
export default function setup(): void {
  registerService('odonto.patients', odontoPatientsService satisfies OdontoPatientsService);
  registerService('odonto.professionals', odontoProfessionalsService satisfies OdontoProfessionalsService);
}
