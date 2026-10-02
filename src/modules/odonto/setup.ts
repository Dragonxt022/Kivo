import { registerService } from '../../core/services/registry';
import { odontoPatientsService, type OdontoPatientsService } from './patients';
import { odontoProfessionalsService, type OdontoProfessionalsService } from './professionals';
import { ensureDefaultTemplate, odontoAnamnesisService, type OdontoAnamnesisService } from './anamnesis';
import { odontoAgendaService, type OdontoAgendaService } from './appointments';

/**
 * Setup do módulo odonto — roda no boot, depois das migrations e antes de qualquer
 * requisição. Publica no Core só o que outros módulos precisam: a agenda (próxima fase)
 * vai escolher paciente e profissional por aqui, sem importar repositório alheio.
 */
export default function setup(): void {
  registerService('odonto.patients', odontoPatientsService satisfies OdontoPatientsService);
  registerService('odonto.professionals', odontoProfessionalsService satisfies OdontoProfessionalsService);
  registerService('odonto.anamnesis', odontoAnamnesisService satisfies OdontoAnamnesisService);
  registerService('odonto.agenda', odontoAgendaService satisfies OdontoAgendaService);
  // Formulário padrão da anamnese: sem ele o consultório não teria por onde começar a
  // responder. Só cria se não existir NENHUM formulário (não mexe no que o usuário montou).
  ensureDefaultTemplate();
}
