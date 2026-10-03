import { registerService } from '../../core/services/registry';
import { odontoPatientsService, type OdontoPatientsService } from './patients';
import { odontoProfessionalsService, type OdontoProfessionalsService } from './professionals';
import { ensureDefaultTemplate, odontoAnamnesisService, type OdontoAnamnesisService } from './anamnesis';
import { odontoAgendaService, type OdontoAgendaService } from './appointments';
import { odontoRecordsService, type OdontoRecordsService } from './clinicalNotes';
import { ensureDefaultConditions, odontoOdontogramService, type OdontoOdontogramService } from './odontogram';
import { odontoPlansService, type OdontoPlansService } from './treatmentPlans';
import { ensureDefaultTemplates, odontoDocumentsService, type OdontoDocumentsService } from './documents';

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
  registerService('odonto.records', odontoRecordsService satisfies OdontoRecordsService);
  registerService('odonto.odontogram', odontoOdontogramService satisfies OdontoOdontogramService);
  registerService('odonto.plans', odontoPlansService satisfies OdontoPlansService);
  registerService('odonto.documents', odontoDocumentsService satisfies OdontoDocumentsService);
  // Formulário padrão da anamnese: sem ele o consultório não teria por onde começar a
  // responder. Só cria se não existir NENHUM formulário (não mexe no que o usuário montou).
  ensureDefaultTemplate();
  // Situações odontológicas iniciais da PR §10 (a clínica cria as suas depois).
  ensureDefaultConditions();
  // Modelos de documento da PR §14 (TCLE, receita, atestado, contrato...): só os que faltam.
  ensureDefaultTemplates();
}
