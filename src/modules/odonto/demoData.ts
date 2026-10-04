import { randomUUID } from 'node:crypto';

import { getSqlite } from '../../core/database/connection';
import { createCustomer } from '../commercial/customers';
import { ensureDefaultTemplate } from './anamnesis';
import { ensureDefaultTemplates } from './documents';
import { ensureDefaultConditions } from './odontogram';
import { patientRepository } from './repositories/PatientRepository';
import { professionalRepository } from './repositories/ProfessionalRepository';
import { procedureRepository } from './repositories/ProcedureRepository';
import { appointmentRepository } from './repositories/AppointmentRepository';
import { anamnesisRepository } from './repositories/AnamnesisRepository';
import { odontogramRepository } from './repositories/OdontogramRepository';
import { treatmentPlanRepository } from './repositories/TreatmentPlanRepository';
import { documentRepository } from './repositories/DocumentRepository';
import { clinicalNoteRepository } from './repositories/ClinicalNoteRepository';
import { examRepository } from './repositories/ExamRepository';
import { deleteExamFile, saveExamFile } from './examFiles';
import {
  fotoClinica, laudoRadiograficoPdf, radiografiaPanoramica, radiografiaPeriapical, tomografia,
} from './demoImages';

/**
 * Clínica de exemplo do Odonto — os dados fictícios que o card "Ambiente de teste" (tela inicial)
 * e o assistente de boas-vindas criam para o dentista conhecer o módulo sem cadastrar nada.
 *
 * TRÊS DECISÕES QUE EXPLICAM O RESTO DO ARQUIVO:
 *
 * 1. Fala com os REPOSITÓRIOS, não com os serviços. Os serviços do módulo exigem um `Request`
 *    autenticado (`assertAuth` LANÇA sem usuário) e uma permissão por operação. Aqui não há
 *    requisição: quem chamou já passou pelo `requirePermission('settings.edit')` da rota. Em
 *    troca, nada de auditoria por linha — o registro fica no evento único da rota
 *    (`odonto_demo_dados`), que é o nível certo para "criou a demonstração inteira".
 *
 * 2. É IDEMPOTENTE por chave natural (nome do profissional, código do procedimento, título do
 *    plano, paciente + horário…). Rodar de novo COMPLETA o que faltar em vez de duplicar, e o
 *    resumo devolvido conta só o que foi realmente criado nesta passada. A agenda é a única parte
 *    relativa ao dia: os atendimentos são montados em torno de HOJE, então rodar em outro dia
 *    acrescenta a semana nova — é o que "regenerar a demonstração" significa.
 *
 * 3. Conta em NOME DE PACIENTE EXISTENTE é recusada, não reaproveitada: se já houver um cliente
 *    com o mesmo nome que NÃO seja nosso (sem a marca em `notes`), o paciente de exemplo é
 *    pulado. Anexar consulta, exame e evolução fictícios na ficha de um paciente real seria o
 *    pior defeito possível deste arquivo.
 *
 * Nada aqui entra em `syncTables` (o módulo inteiro é local): a demonstração não sobe para a nuvem
 * e não contamina outra máquina da empresa.
 */

/** Marca que separa o que é nosso do que é do consultório. Vai em `notes`, que a ficha mostra. */
export const DEMO_MARK = 'Paciente de exemplo — dados fictícios criados pelo Kivo para demonstração.';

export interface OdontoDemoSummary {
  profissionais: number;
  pacientes: number;
  /** Nomes que já existiam como cliente real e foram deixados em paz. */
  pacientesIgnorados: number;
  procedimentos: number;
  anamneses: number;
  agendamentos: number;
  evolucoes: number;
  estadosOdontograma: number;
  planos: number;
  itensPlano: number;
  documentos: number;
  exames: number;
}

export interface OdontoDemoResumo {
  pacientes: number;
  profissionais: number;
  agendamentos: number;
  planos: number;
  exames: number;
}

type Sexo = 'feminino' | 'masculino' | 'outro' | 'nao_informado';
type StatusAgendamento = 'agendado' | 'confirmado' | 'em_atendimento' | 'atendido' | 'faltou' | 'cancelado';
type StatusPlano = 'planejado' | 'apresentado' | 'aprovado' | 'em_andamento' | 'concluido' | 'cancelado';
type StatusItem = 'planejado' | 'aprovado' | 'em_andamento' | 'concluido' | 'cancelado';

interface DemoProfissional {
  name: string; cro: string | null; cro_state: string | null;
  specialties: string; phone: string; email: string | null;
}

interface DemoPaciente {
  nome: string; sexo: Sexo; nascimento: string; telefone: string; email: string | null;
  /** Só o que faz diferença na demonstração: alergia, medicação, histórico e condição. */
  alergias?: string; medicamentos?: string; historico?: string;
  odontologico?: string; condicoes?: string;
}

interface DemoProcedimento {
  code: string; name: string; category: string; price: number; minutos: number;
  /** Nome do produto/serviço do catálogo comercial que este procedimento reaproveita. */
  produto: string | null;
}

interface DemoAgendamento {
  paciente: number; profissional: number; procedimento: string;
  dias: number; hora: string; duracao: number; status: StatusAgendamento;
  cancelReason?: string;
}

interface DemoDente {
  paciente: number; tooth: string; surface: string | null; code: string;
  kind: 'situacao' | 'planejado'; dias: number; note: string;
}

interface DemoItemPlano {
  procedimento: string; tooth: string | null; description: string;
  amount: number; quantity: number; status: StatusItem;
}

interface DemoPlano {
  paciente: number; profissional: number; title: string; status: StatusPlano;
  diasApresentado: number | null; diasAprovado: number | null;
  diasInicio: number | null; diasFim: number | null;
  notes: string; items: DemoItemPlano[];
}

interface DemoDocumento {
  paciente: number; profissional: number;
  /** Código de um modelo semeado (`ensureDefaultTemplates`), quando o documento nasce de um. */
  code: string | null;
  type: string; title: string; status: 'rascunho' | 'emitido'; dias: number;
  /** Índice do plano na lista PLANOS, quando o documento nasce do orçamento. */
  plano: number | null;
  corpo: (paciente: string, profissional: string, cro: string) => string;
}

interface DemoEvolucao {
  paciente: number; profissional: number; dias: number; hora: string;
  title: string; procedimentos: { code: string; tooth: string | null; note?: string }[];
  observations: string; diagnosis: string; conduct: string; next: string;
  /** Índice (na lista EVOLUCOES) da versão que este registro retifica. */
  retifica?: number;
}

interface DemoExame {
  paciente: number; profissional: number; title: string; type: string;
  phase: 'antes' | 'durante' | 'depois' | null; tooth: string | null;
  description: string; dias: number;
  /** Índice do plano, quando o exame pertence àquele tratamento. */
  plano: number | null;
  arquivo: { nome: string; mime: string; conteudo: () => Buffer };
}

const PROFISSIONAIS: DemoProfissional[] = [
  { name: 'Dra. Helena Prado', cro: '45821', cro_state: 'SP', specialties: 'Ortodontia, Dentística', phone: '(11) 98812-4477', email: 'helena.prado@clinicaexemplo.com.br' },
  { name: 'Dr. Rafael Nakamura', cro: '33107', cro_state: 'SP', specialties: 'Implantodontia, Cirurgia', phone: '(11) 98812-4488', email: 'rafael.nakamura@clinicaexemplo.com.br' },
  { name: 'Dra. Camila Queiroz', cro: '51230', cro_state: 'SP', specialties: 'Endodontia', phone: '(11) 98812-4499', email: 'camila.queiroz@clinicaexemplo.com.br' },
  { name: 'Bruno Sales (auxiliar)', cro: null, cro_state: null, specialties: 'Auxiliar de saúde bucal', phone: '(11) 98812-4500', email: null },
];

const PROCEDIMENTOS: DemoProcedimento[] = [
  { code: 'DEMO-AVALIACAO', name: 'Avaliação inicial', category: 'Diagnóstico', price: 15000, minutos: 30, produto: 'Avaliação inicial' },
  { code: 'DEMO-PROFILAXIA', name: 'Profilaxia (limpeza)', category: 'Prevenção', price: 18000, minutos: 40, produto: 'Profilaxia (limpeza)' },
  { code: 'DEMO-RESTAURACAO', name: 'Restauração em resina', category: 'Dentística', price: 25000, minutos: 50, produto: 'Restauração em resina' },
  { code: 'DEMO-CANAL', name: 'Tratamento de canal (unirradicular)', category: 'Endodontia', price: 90000, minutos: 90, produto: 'Tratamento de canal (unirradicular)' },
  { code: 'DEMO-CLAREAMENTO', name: 'Clareamento dental (consultório)', category: 'Estética', price: 70000, minutos: 60, produto: 'Clareamento dental (consultório)' },
  { code: 'DEMO-EXTRACAO-38', name: 'Extração de terceiro molar', category: 'Cirurgia', price: 60000, minutos: 60, produto: 'Extração de terceiro molar' },
  { code: 'DEMO-IMPLANTE', name: 'Implante unitário (instalação)', category: 'Implantodontia', price: 250000, minutos: 120, produto: null },
  { code: 'DEMO-COROA', name: 'Coroa unitária em cerâmica', category: 'Prótese', price: 180000, minutos: 90, produto: null },
  { code: 'DEMO-RX-PERIAPICAL', name: 'Radiografia periapical', category: 'Imagem', price: 6000, minutos: 15, produto: null },
  { code: 'DEMO-ORTODONTIA', name: 'Manutenção de aparelho ortodôntico', category: 'Ortodontia', price: 22000, minutos: 30, produto: null },
];

const PACIENTES: DemoPaciente[] = [
  { nome: 'Ana Beatriz Ferreira', sexo: 'feminino', nascimento: '1988-04-12', telefone: '(11) 99123-4567', email: 'ana.ferreira@exemplo.com.br', alergias: 'Penicilina', historico: 'Sem cirurgias anteriores.', odontologico: 'Tratamento de canal em 2019.' },
  { nome: 'Carlos Eduardo Lima', sexo: 'masculino', nascimento: '1975-09-30', telefone: '(11) 99234-5678', email: 'carlos.lima@exemplo.com.br', medicamentos: 'Losartana 50mg (uso contínuo)', condicoes: 'Hipertensão controlada', historico: 'Cirurgia de apendicite (2005).' },
  { nome: 'Mariana Souza Alves', sexo: 'feminino', nascimento: '1996-01-22', telefone: '(11) 99345-6789', email: 'mariana.alves@exemplo.com.br', odontologico: 'Usa aparelho ortodôntico desde 2023.' },
  { nome: 'João Pedro Martins', sexo: 'masculino', nascimento: '2004-07-08', telefone: '(11) 99456-7890', email: null, historico: 'Paciente adolescente — responsável: Sônia Martins.' },
  { nome: 'Fernanda Ribeiro Castro', sexo: 'feminino', nascimento: '1982-11-03', telefone: '(11) 99567-8901', email: 'fernanda.castro@exemplo.com.br', alergias: 'Látex', odontologico: 'Sensibilidade dentária relatada.' },
  { nome: 'Ricardo Nogueira Pinto', sexo: 'masculino', nascimento: '1969-02-17', telefone: '(11) 99678-9012', email: 'ricardo.pinto@exemplo.com.br', medicamentos: 'AAS 100mg', condicoes: 'Diabetes tipo 2', historico: 'Necessário cuidado com sangramento.' },
  { nome: 'Larissa Monteiro Dias', sexo: 'feminino', nascimento: '1999-06-25', telefone: '(11) 99789-0123', email: 'larissa.dias@exemplo.com.br' },
  { nome: 'Paulo Henrique Barros', sexo: 'masculino', nascimento: '1991-12-09', telefone: '(11) 99890-1234', email: 'paulo.barros@exemplo.com.br', odontologico: 'Relata bruxismo noturno.' },
  { nome: 'Juliana Teixeira Rocha', sexo: 'feminino', nascimento: '1978-03-14', telefone: '(11) 99901-2345', email: 'juliana.rocha@exemplo.com.br', alergias: 'Dipirona' },
  { nome: 'Marcos Vinícius Araújo', sexo: 'masculino', nascimento: '2001-08-19', telefone: '(11) 99012-3456', email: 'marcos.araujo@exemplo.com.br' },
];

/**
 * Agenda em torno de HOJE: dias negativos já aconteceram (atendido/faltou), zero é o dia atual e
 * os positivos são o que o consultório tem marcado. Os horários de um mesmo profissional nunca se
 * sobrepõem — o repositório não checa isso (quem checa é o serviço), então a coerência é
 * responsabilidade desta lista.
 */
const AGENDA: DemoAgendamento[] = [
  { paciente: 0, profissional: 0, procedimento: 'DEMO-PROFILAXIA', dias: -7, hora: '09:00', duracao: 40, status: 'atendido' },
  { paciente: 2, profissional: 0, procedimento: 'DEMO-ORTODONTIA', dias: -5, hora: '14:00', duracao: 30, status: 'atendido' },
  { paciente: 4, profissional: 0, procedimento: 'DEMO-CLAREAMENTO', dias: -2, hora: '10:00', duracao: 60, status: 'atendido' },
  { paciente: 1, profissional: 0, procedimento: 'DEMO-AVALIACAO', dias: 0, hora: '09:00', duracao: 30, status: 'confirmado' },
  { paciente: 6, profissional: 0, procedimento: 'DEMO-PROFILAXIA', dias: 0, hora: '11:00', duracao: 40, status: 'agendado' },
  { paciente: 8, profissional: 0, procedimento: 'DEMO-ORTODONTIA', dias: 2, hora: '15:00', duracao: 30, status: 'confirmado' },
  { paciente: 3, profissional: 0, procedimento: 'DEMO-CLAREAMENTO', dias: 4, hora: '09:30', duracao: 60, status: 'agendado' },

  { paciente: 1, profissional: 1, procedimento: 'DEMO-EXTRACAO-38', dias: -6, hora: '08:30', duracao: 60, status: 'atendido' },
  { paciente: 5, profissional: 1, procedimento: 'DEMO-IMPLANTE', dias: -3, hora: '16:00', duracao: 120, status: 'atendido' },
  { paciente: 5, profissional: 1, procedimento: 'DEMO-AVALIACAO', dias: 0, hora: '14:00', duracao: 30, status: 'confirmado' },
  { paciente: 8, profissional: 1, procedimento: 'DEMO-EXTRACAO-38', dias: 0, hora: '16:00', duracao: 60, status: 'agendado' },
  { paciente: 7, profissional: 1, procedimento: 'DEMO-IMPLANTE', dias: 3, hora: '10:00', duracao: 120, status: 'agendado' },
  { paciente: 9, profissional: 1, procedimento: 'DEMO-AVALIACAO', dias: 6, hora: '09:00', duracao: 30, status: 'agendado' },

  { paciente: 0, profissional: 2, procedimento: 'DEMO-CANAL', dias: -4, hora: '11:00', duracao: 90, status: 'atendido' },
  { paciente: 3, profissional: 2, procedimento: 'DEMO-CANAL', dias: -1, hora: '09:00', duracao: 90, status: 'faltou' },
  { paciente: 0, profissional: 2, procedimento: 'DEMO-RESTAURACAO', dias: 0, hora: '08:00', duracao: 50, status: 'em_atendimento' },
  { paciente: 7, profissional: 2, procedimento: 'DEMO-RESTAURACAO', dias: 0, hora: '15:30', duracao: 50, status: 'confirmado' },
  { paciente: 2, profissional: 2, procedimento: 'DEMO-CANAL', dias: 2, hora: '09:00', duracao: 90, status: 'agendado' },
  { paciente: 9, profissional: 2, procedimento: 'DEMO-RESTAURACAO', dias: 5, hora: '14:00', duracao: 50, status: 'cancelado', cancelReason: 'Paciente pediu para remarcar' },
];

/** Odontograma: o que o exame inicial encontrou (situação) e o que ficou previsto (planejado). */
const DENTES: DemoDente[] = [
  { paciente: 0, tooth: '16', surface: 'O', code: 'carie', kind: 'situacao', dias: -7, note: 'Cárie oclusal — indicada restauração.' },
  { paciente: 0, tooth: '26', surface: 'O', code: 'restaurado', kind: 'situacao', dias: -4, note: 'Restauração em resina concluída.' },
  { paciente: 0, tooth: '38', surface: null, code: 'extracao_indicada', kind: 'situacao', dias: -6, note: 'Incluso, sem espaço na arcada.' },
  { paciente: 0, tooth: '38', surface: null, code: 'extracao_indicada', kind: 'planejado', dias: -6, note: 'Cirurgia prevista.' },
  { paciente: 0, tooth: '46', surface: null, code: 'ausente', kind: 'situacao', dias: -6, note: 'Perdido em 2015 (relato do paciente).' },
  { paciente: 1, tooth: '11', surface: null, code: 'fratura', kind: 'situacao', dias: -3, note: 'Fratura de esmalte por trauma.' },
  { paciente: 1, tooth: '14', surface: null, code: 'ausente', kind: 'situacao', dias: -6, note: 'Extraído; indicado implante.' },
  { paciente: 1, tooth: '14', surface: null, code: 'implante', kind: 'planejado', dias: -3, note: 'Instalação programada.' },
  { paciente: 1, tooth: '24', surface: 'M', code: 'carie', kind: 'situacao', dias: -3, note: 'Cárie interproximal inicial.' },
  { paciente: 2, tooth: '36', surface: null, code: 'endodontia', kind: 'situacao', dias: -5, note: 'Canal concluído em 2021.' },
  { paciente: 2, tooth: '21', surface: 'V', code: 'restaurado', kind: 'situacao', dias: -5, note: 'Restauração estética.' },
];

const PLANOS: DemoPlano[] = [
  {
    paciente: 0, profissional: 2, title: 'Endodontia e restauração do dente 26', status: 'em_andamento',
    diasApresentado: -5, diasAprovado: -4, diasInicio: -4, diasFim: null,
    notes: 'Paciente com dor à mastigação; tratamento em duas sessões.',
    items: [
      { procedimento: 'DEMO-CANAL', tooth: '26', description: 'Tratamento de canal (unirradicular)', amount: 90000, quantity: 1, status: 'concluido' },
      { procedimento: 'DEMO-RESTAURACAO', tooth: '26', description: 'Restauração em resina', amount: 25000, quantity: 1, status: 'em_andamento' },
      { procedimento: 'DEMO-RX-PERIAPICAL', tooth: '26', description: 'Radiografia periapical de controle', amount: 6000, quantity: 2, status: 'planejado' },
    ],
  },
  {
    paciente: 1, profissional: 1, title: 'Reabilitação com implante — dente 14', status: 'aprovado',
    diasApresentado: -4, diasAprovado: -3, diasInicio: null, diasFim: null,
    notes: 'Aguardando exames pré-operatórios (hemograma e glicemia).',
    items: [
      { procedimento: 'DEMO-IMPLANTE', tooth: '14', description: 'Implante unitário (instalação)', amount: 250000, quantity: 1, status: 'aprovado' },
      { procedimento: 'DEMO-COROA', tooth: '14', description: 'Coroa unitária em cerâmica sobre implante', amount: 180000, quantity: 1, status: 'planejado' },
    ],
  },
  {
    paciente: 2, profissional: 0, title: 'Clareamento e profilaxia', status: 'planejado',
    diasApresentado: 0, diasAprovado: null, diasInicio: null, diasFim: null,
    notes: 'Apresentado no atendimento de hoje; a paciente vai avaliar o valor.',
    items: [
      { procedimento: 'DEMO-CLAREAMENTO', tooth: null, description: 'Clareamento dental (consultório)', amount: 70000, quantity: 1, status: 'planejado' },
      { procedimento: 'DEMO-PROFILAXIA', tooth: null, description: 'Profilaxia (limpeza)', amount: 18000, quantity: 1, status: 'planejado' },
    ],
  },
  {
    paciente: 4, profissional: 0, title: 'Profilaxia e orientação de higiene', status: 'concluido',
    diasApresentado: -3, diasAprovado: -3, diasInicio: -2, diasFim: -2,
    notes: 'Paciente com sensibilidade; orientada a troca do dentifrício.',
    items: [
      { procedimento: 'DEMO-PROFILAXIA', tooth: null, description: 'Profilaxia (limpeza)', amount: 18000, quantity: 1, status: 'concluido' },
      { procedimento: 'DEMO-AVALIACAO', tooth: null, description: 'Avaliação inicial', amount: 15000, quantity: 1, status: 'concluido' },
    ],
  },
];

const DOCUMENTOS: DemoDocumento[] = [
  {
    paciente: 0, profissional: 2, code: 'tcle_padrao', type: 'tcle', status: 'emitido', dias: -4, plano: 0,
    title: 'TCLE — tratamento endodôntico do dente 26',
    corpo: (p, prof, cro) => [
      'TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO',
      '',
      `Paciente: ${p}`,
      '',
      'Declaro que fui informado(a), em linguagem acessível, sobre o diagnóstico, a natureza e o',
      'objetivo do tratamento endodôntico (tratamento de canal) do dente 26, sobre os riscos',
      'possíveis (dor pós-operatória, fratura da coroa, necessidade de retratamento) e sobre as',
      'alternativas de tratamento.',
      '',
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 0, profissional: 2, code: 'receita_padrao', type: 'receita', status: 'emitido', dias: -4, plano: null,
    title: 'Receita — analgesia pós-operatória',
    corpo: (p, prof, cro) => [
      'RECEITA ODONTOLÓGICA',
      '',
      `Paciente: ${p}`,
      '',
      '1) Ibuprofeno 400mg — 1 comprimido a cada 8 horas, por 3 dias, em caso de dor.',
      '2) Paracetamol 750mg — 1 comprimido a cada 6 horas se a dor persistir.',
      '',
      'Orientações: não mastigar do lado tratado por 24 horas; retornar em caso de sangramento.',
      '',
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 0, profissional: 2, code: 'orcamento_plano', type: 'plano_tratamento', status: 'rascunho', dias: -5, plano: 0,
    title: 'Orçamento — endodontia e restauração do dente 26',
    corpo: (p, prof, cro) => [
      'ORÇAMENTO DE TRATAMENTO ODONTOLÓGICO',
      '',
      `Paciente: ${p}`,
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Tratamento de canal (unirradicular) — dente 26 ............ R$ 900,00',
      'Restauração em resina — dente 26 ......................... R$ 250,00',
      'Radiografia periapical de controle (2) ................... R$ 120,00',
      '',
      'Total: R$ 1.270,00 — em até 6x sem juros.',
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 1, profissional: 1, code: 'contrato_padrao', type: 'contrato', status: 'emitido', dias: -3, plano: 1,
    title: 'Contrato de prestação de serviços — reabilitação com implante',
    corpo: (p, prof, cro) => [
      'CONTRATO DE PRESTAÇÃO DE SERVIÇOS ODONTOLÓGICOS',
      '',
      `Contratante: ${p}`,
      'Contratada: clínica de exemplo (demonstração do Kivo)',
      `Responsável técnico: ${prof} — CRO ${cro}`,
      '',
      'Objeto: instalação de implante unitário e coroa em cerâmica na região do dente 14.',
      'Valor total: R$ 4.300,00, em 10 parcelas mensais.',
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 1, profissional: 1, code: 'tcle_padrao', type: 'tcle', status: 'emitido', dias: -3, plano: 1,
    title: 'TCLE — cirurgia para instalação de implante',
    corpo: (p, prof, cro) => [
      'TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO',
      '',
      `Paciente: ${p}`,
      '',
      'Fui informado(a) sobre a cirurgia para instalação de implante osseointegrado na região do',
      'dente 14, incluindo os riscos de edema, dor, sangramento, infecção, falha de',
      'osseointegração e necessidade de enxerto complementar.',
      '',
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 2, profissional: 0, code: 'atestado_padrao', type: 'atestado', status: 'emitido', dias: -5, plano: null,
    title: 'Atestado odontológico — comparecimento',
    corpo: (p, prof, cro) => [
      'ATESTADO ODONTOLÓGICO',
      '',
      `Atesto, para os devidos fins, que o(a) paciente ${p} compareceu a esta clínica para`,
      'atendimento odontológico nesta data, no período da tarde.',
      '',
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
  {
    paciente: 3, profissional: 2, code: 'declaracao_comparecimento', type: 'declaracao', status: 'emitido', dias: -1, plano: null,
    title: 'Declaração de comparecimento',
    corpo: (p, prof, cro) => [
      'DECLARAÇÃO DE COMPARECIMENTO',
      '',
      `Declaro que ${p} esteve presente nesta clínica na data de hoje, para consulta odontológica.`,
      '',
      `Profissional responsável: ${prof} — CRO ${cro}`,
      '',
      'Documento de exemplo, gerado pela demonstração do Kivo.',
    ].join('\n'),
  },
];

/**
 * Prontuário. O primeiro registro da Ana Beatriz tem DUAS versões de propósito: a retificação é a
 * regra central do prontuário (PR §8 — registro assinado não se apaga, corrige-se com motivo) e,
 * sem um exemplo na demonstração, a tela de histórico de versões abriria sempre vazia.
 */
const EVOLUCOES: DemoEvolucao[] = [
  {
    paciente: 0, profissional: 0, dias: -7, hora: '09:40',
    title: 'Profilaxia e levantamento inicial',
    procedimentos: [{ code: 'DEMO-PROFILAXIA', tooth: null }],
    observations: 'Higiene bucal regular; sangramento gengival leve na região posterior.',
    diagnosis: 'Gengivite leve; lesão de cárie oclusal no elemento 16 (a confirmar por radiografia).',
    conduct: 'Profilaxia concluída e radiografia panorâmica solicitada.',
    next: 'Retorno com a radiografia para decidir a restauração do 16.',
  },
  {
    paciente: 0, profissional: 0, dias: -6, hora: '10:20',
    title: 'Profilaxia e levantamento inicial (corrigido)',
    procedimentos: [{ code: 'DEMO-PROFILAXIA', tooth: null, note: 'Registro corrigido após conferência da radiografia.' }],
    observations: 'Higiene bucal regular; sangramento gengival leve na região posterior.',
    diagnosis: 'Gengivite leve; lesão de cárie oclusal no elemento 26 — o 16 estava hígido na radiografia.',
    conduct: 'Profilaxia concluída e radiografia panorâmica solicitada.',
    next: 'Retorno para tratamento endodôntico do 26.',
    retifica: 0,
  },
  {
    paciente: 0, profissional: 2, dias: -4, hora: '12:30',
    title: 'Tratamento endodôntico — primeira sessão',
    procedimentos: [{ code: 'DEMO-CANAL', tooth: '26' }, { code: 'DEMO-RX-PERIAPICAL', tooth: '26' }],
    observations: 'Acesso coronário realizado; medicação intracanal aplicada.',
    diagnosis: 'Pulpite irreversível no elemento 26.',
    conduct: 'Medicação intracanal e restauração provisória.',
    next: 'Retorno em 15 dias para obturação dos canais.',
  },
  {
    paciente: 1, profissional: 1, dias: -6, hora: '09:30',
    title: 'Exodontia do terceiro molar inferior direito (38)',
    procedimentos: [{ code: 'DEMO-EXTRACAO-38', tooth: '38' }, { code: 'DEMO-RX-PERIAPICAL', tooth: '38' }],
    observations: 'Cirurgia sem intercorrências; sutura com fio reabsorvível.',
    diagnosis: 'Terceiro molar incluso com indicação de extração.',
    conduct: 'Exodontia concluída; prescrição de analgesia e orientações pós-operatórias.',
    next: 'Retorno em 7 dias para remoção da sutura.',
  },
  {
    paciente: 1, profissional: 1, dias: -3, hora: '16:10',
    title: 'Avaliação para reabilitação com implante',
    procedimentos: [{ code: 'DEMO-AVALIACAO', tooth: '14' }],
    observations: 'Rebordo cicatrizado, altura óssea adequada na tomografia.',
    diagnosis: 'Ausência do elemento 14 com indicação de implante unitário.',
    conduct: 'Plano de tratamento apresentado e aprovado pelo paciente.',
    next: 'Solicitados hemograma e glicemia para a cirurgia.',
  },
  {
    paciente: 2, profissional: 0, dias: -5, hora: '14:30',
    title: 'Manutenção de aparelho ortodôntico',
    procedimentos: [{ code: 'DEMO-ORTODONTIA', tooth: null }],
    observations: 'Arco superior sem dobras; elásticos trocados.',
    diagnosis: 'Evolução ortodôntica dentro do esperado.',
    conduct: 'Manutenção mensal e reforço de higiene com escova interdental.',
    next: 'Retorno em 30 dias.',
  },
  {
    paciente: 4, profissional: 0, dias: -2, hora: '10:50',
    title: 'Profilaxia e orientação de higiene',
    procedimentos: [{ code: 'DEMO-PROFILAXIA', tooth: null }, { code: 'DEMO-AVALIACAO', tooth: null }],
    observations: 'Relata sensibilidade ao frio nos pré-molares.',
    diagnosis: 'Exposição de colo dentário por escovação traumática.',
    conduct: 'Profilaxia, aplicação de dessensibilizante e orientação de técnica de escovação.',
    next: 'Retorno em 6 meses.',
  },
  {
    paciente: 5, profissional: 1, dias: -3, hora: '17:10',
    title: 'Avaliação inicial para implante',
    procedimentos: [{ code: 'DEMO-AVALIACAO', tooth: null }],
    observations: 'Paciente diabético controlado, com AAS em uso.',
    diagnosis: 'Edentulismo parcial posterior; necessário controle glicêmico antes da cirurgia.',
    conduct: 'Solicitada avaliação clínica e exames laboratoriais atualizados.',
    next: 'Reavaliar após liberação clínica.',
  },
];

const EXAMES: DemoExame[] = [
  {
    paciente: 0, profissional: 0, title: 'Radiografia panorâmica — levantamento inicial',
    type: 'radiografia', phase: null, tooth: null, dias: -7, plano: null,
    description: 'Panorâmica de boca toda para o levantamento inicial.',
    arquivo: { nome: 'radiografia-panoramica-exemplo.png', mime: 'image/png', conteudo: radiografiaPanoramica },
  },
  {
    paciente: 0, profissional: 2, title: 'Radiografia periapical — dente 26',
    type: 'radiografia', phase: null, tooth: '26', dias: -4, plano: 0,
    description: 'Imagem periapical de controle antes da obturação dos canais.',
    arquivo: { nome: 'radiografia-periapical-26-exemplo.png', mime: 'image/png', conteudo: radiografiaPeriapical },
  },
  {
    paciente: 1, profissional: 1, title: 'Tomografia — planejamento do implante do 14',
    type: 'tomografia', phase: null, tooth: '14', dias: -4, plano: 1,
    description: 'Cortes axiais para avaliação da altura e da espessura óssea.',
    arquivo: { nome: 'tomografia-14-exemplo.png', mime: 'image/png', conteudo: tomografia },
  },
  {
    paciente: 1, profissional: 1, title: 'Laudo radiológico — planejamento cirúrgico',
    type: 'documento', phase: null, tooth: '14', dias: -4, plano: 1,
    description: 'Laudo em PDF anexado ao plano de reabilitação.',
    arquivo: { nome: 'laudo-radiologico-exemplo.pdf', mime: 'application/pdf', conteudo: laudoRadiograficoPdf },
  },
  {
    paciente: 2, profissional: 0, title: 'Fotografia clínica — antes do clareamento',
    type: 'fotografia', phase: 'antes', tooth: null, dias: -5, plano: 2,
    description: 'Registro inicial da cor e do alinhamento dos incisivos.',
    arquivo: { nome: 'foto-antes-clareamento-exemplo.png', mime: 'image/png', conteudo: () => fotoClinica('antes') },
  },
  {
    paciente: 2, profissional: 0, title: 'Fotografia clínica — depois do clareamento',
    type: 'fotografia', phase: 'depois', tooth: null, dias: -1, plano: 2,
    description: 'Registro final para comparação com a foto inicial.',
    arquivo: { nome: 'foto-depois-clareamento-exemplo.png', mime: 'image/png', conteudo: () => fotoClinica('depois') },
  },
];

// ─────────────────────────────── Helpers ───────────────────────────────

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0');
}

/** Data local no formato do banco (`YYYY-MM-DD`), deslocada em dias a partir de hoje. */
function dia(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

/** Data e hora no formato do banco (`YYYY-MM-DD HH:MM`) — relógio de parede, como a agenda grava. */
function quando(offset: number, hora: string): string {
  return `${dia(offset)} ${hora}`;
}

/** Soma minutos a um `YYYY-MM-DD HH:MM` (para o fim do atendimento). */
function maisMinutos(dataHora: string, minutos: number): string {
  const [data, hora] = dataHora.split(' ');
  const [ano, mes, dd] = data.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  const dt = new Date(ano, mes - 1, dd, hh, mm + minutos);
  return `${dt.getFullYear()}-${doisDigitos(dt.getMonth() + 1)}-${doisDigitos(dt.getDate())} ${doisDigitos(dt.getHours())}:${doisDigitos(dt.getMinutes())}`;
}

function tabelaExiste(nome: string): boolean {
  const row = getSqlite()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(nome) as { name: string } | undefined;
  return !!row;
}

/**
 * A instalação tem o módulo Odonto? As migrations do módulo só rodam quando ele é carregado (o
 * loader pula o que o plano não libera), então a existência da tabela é a resposta exata — melhor
 * que adivinhar por licença/plano, que teria duas fontes possíveis para a mesma verdade.
 */
export function odontoDemoDisponivel(): boolean {
  try {
    return tabelaExiste('odonto_patients') && tabelaExiste('odonto_exams');
  } catch {
    return false;
  }
}

/** O que o consultório tem hoje (de exemplo ou real) — o card da tela inicial mostra este resumo. */
export function odontoDemoResumo(): OdontoDemoResumo {
  const um = (sql: string): number => {
    const row = patientRepository.rawOne(sql) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  };
  return {
    pacientes: um('SELECT COUNT(*) AS n FROM odonto_patients WHERE deleted_at IS NULL'),
    profissionais: um('SELECT COUNT(*) AS n FROM odonto_professionals WHERE deleted_at IS NULL'),
    agendamentos: um('SELECT COUNT(*) AS n FROM odonto_appointments WHERE deleted_at IS NULL'),
    planos: um('SELECT COUNT(*) AS n FROM odonto_treatment_plans WHERE deleted_at IS NULL'),
    exames: um('SELECT COUNT(*) AS n FROM odonto_exams WHERE deleted_at IS NULL'),
  };
}

// ─────────────────────────── Criação idempotente ───────────────────────────
//
// Convenção: todo `garantir*` devolve o id e se a linha FOI criada agora (`criado`). O resumo conta
// só o que nasceu nesta passada; id reaproveitado não infla o número da auditoria.

function garantirProfissional(p: DemoProfissional): { id: number; criado: boolean } {
  const existente = professionalRepository.findByName(p.name);
  if (existente) return { id: Number(existente.id), criado: false };
  const id = professionalRepository.create({
    user_id: null, name: p.name, cro: p.cro, cro_state: p.cro_state,
    specialties: p.specialties, phone: p.phone, email: p.email, active: 1, uuid: randomUUID(),
  });
  return { id, criado: true };
}

function garantirProcedimento(p: DemoProcedimento): { id: number; criado: boolean } {
  const existente = procedureRepository.findByCode(p.code);
  if (existente) return { id: Number(existente.id), criado: false };
  // O produto do catálogo comercial entra quando existe (o ramo odontologia do assistente cria
  // esses serviços): é o que evita dois preços para a mesma coisa — o desenho da fase 1.
  const produto = p.produto
    ? procedureRepository.rawOne(
      `SELECT id FROM products WHERE name = ? AND deleted_at IS NULL LIMIT 1`, p.produto,
    ) as { id: number } | undefined
    : undefined;
  const id = procedureRepository.create({
    product_id: produto ? produto.id : null, code: p.code, name: p.name, category: p.category,
    description: null, default_price_cents: p.price, duration_min: p.minutos, active: 1,
    uuid: randomUUID(),
  });
  return { id, criado: true };
}

/**
 * Paciente de exemplo. Devolve `null` quando JÁ EXISTE um cliente com esse nome que não é nosso:
 * anexar consulta, exame ou evolução fictícios na ficha de um paciente real seria o pior defeito
 * possível aqui, então nesse caso a gente simplesmente não cria (e conta em `pacientesIgnorados`).
 */
function garantirPaciente(p: DemoPaciente): { id: number; criado: boolean } | null {
  const homonimo = patientRepository.rawOne(
    `SELECT p.id, p.notes FROM odonto_patients p
       JOIN customers c ON c.id = p.customer_id
      WHERE c.name = ? AND p.deleted_at IS NULL LIMIT 1`, p.nome,
  ) as { id: number; notes: string | null } | undefined;
  if (homonimo) {
    if (homonimo.notes === DEMO_MARK) return { id: Number(homonimo.id), criado: false };
    return null;
  }

  const clienteExistente = patientRepository.rawOne(
    'SELECT id FROM customers WHERE name = ? AND deleted_at IS NULL LIMIT 1', p.nome,
  ) as { id: number } | undefined;
  if (clienteExistente) return null;

  const customerId = createCustomer({
    name: p.nome, email: p.email, phone: p.telefone, birthday: p.nascimento, notes: DEMO_MARK,
  });
  const id = patientRepository.create({
    customer_id: customerId, sex: p.sexo, rg: null, photo_file: null, notes: DEMO_MARK, active: 1,
    uuid: randomUUID(),
  });
  patientRepository.upsertClinical(id, {
    medical_history: p.historico ?? null,
    dental_history: p.odontologico ?? null,
    allergies: p.alergias ?? null,
    medications: p.medicamentos ?? null,
    conditions: p.condicoes ?? null,
    clinical_notes: null,
  }, null);
  return { id, criado: true };
}

function garantirAnamnese(patientId: number, templateId: number, templateVersion: number, professionalId: number): number {
  if (anamnesisRepository.latestForm(patientId)) return 0;
  // Respostas com as CHAVES e os TIPOS exatos do formulário padrão (o serviço recusaria chave
  // desconhecida e `sim_nao` fora de sim/nao/nao_sei). O repositório não valida, mas um formulário
  // com resposta inválida apareceria torto na tela — e é justamente a tela que estamos demonstrando.
  const respostas = {
    queixa_principal: 'Consulta de rotina; sem queixa de dor no momento.',
    historico_medico: 'Nega doenças crônicas relevantes.',
    doencas: 'Nenhuma relatada',
    alergias: 'Nenhuma relatada',
    medicamentos: 'Nenhum de uso contínuo',
    habitos: ['Nenhum'],
    historico_odontologico: 'Tratamentos anteriores sem intercorrências.',
    gestante: 'Não se aplica',
    pressao_alta: 'nao',
    diabetes: 'nao',
    cardiopatia: 'nao',
    anticoagulante: 'nao',
    cirurgia_recente: 'nao',
    ultima_consulta: dia(-400),
    observacoes: 'Respostas fictícias criadas pela demonstração do Kivo.',
  };
  anamnesisRepository.createForm({
    patient_id: patientId, template_id: templateId, template_version: templateVersion,
    revision: anamnesisRepository.maxRevision(patientId) + 1,
    answers_json: JSON.stringify(respostas), professional_id: professionalId, filled_by: null,
    notes: 'Anamnese preenchida no primeiro atendimento.',
  });
  return 1;
}

function criarAgendamento(
  a: DemoAgendamento, patientId: number, professionalId: number, procedureId: number | null,
): number {
  const inicio = quando(a.dias, a.hora);
  const existente = appointmentRepository.rawOne(
    `SELECT id FROM odonto_appointments
      WHERE patient_id = ? AND professional_id = ? AND starts_at = ? AND deleted_at IS NULL LIMIT 1`,
    patientId, professionalId, inicio,
  ) as { id: number } | undefined;
  if (existente) return 0;

  const fim = maisMinutos(inicio, a.duracao);
  const jaComecou = a.dias < 0 || a.status === 'em_atendimento';
  const id = appointmentRepository.create({
    patient_id: patientId, professional_id: professionalId, procedure_id: procedureId,
    starts_at: inicio, duration_min: a.duracao, status: a.status,
    room: `Cadeira ${(professionalId % 3) + 1}`,
    notes: null, is_fit_in: 0, cancel_reason: a.cancelReason ?? null,
    confirmed_at: a.status === 'agendado' ? null : quando(a.dias - 1, '18:00'),
    started_at: jaComecou ? inicio : null,
    finished_at: a.status === 'atendido' ? fim : null,
    cancelled_at: a.status === 'cancelado' ? quando(a.dias - 1, '17:00') : null,
  });

  // Histórico append-only, pelo mesmo caminho que a tela usa (criado → confirmado → atendido…):
  // sem isso a aba de histórico de um atendimento de exemplo abriria vazia.
  appointmentRepository.addEvent({ appointment_id: id, event: 'criado', to_status: 'agendado', user_id: null });
  if (a.status !== 'agendado') {
    appointmentRepository.addEvent({
      appointment_id: id, event: a.status, from_status: 'agendado', to_status: a.status, user_id: null,
    });
  }
  return 1;
}

function garantirDente(d: DemoDente, patientId: number, professionalId: number): number {
  const condicao = odontogramRepository.findConditionByCode(d.code);
  if (!condicao) return 0;
  const existente = odontogramRepository.rawOne(
    `SELECT id FROM odonto_tooth_states
      WHERE patient_id = ? AND tooth = ? AND surface IS ? AND kind = ? AND condition_id = ?
        AND undone_at IS NULL AND deleted_at IS NULL LIMIT 1`,
    patientId, d.tooth, d.surface, d.kind, condicao.id,
  ) as { id: number } | undefined;
  if (existente) return 0;

  const profissional = professionalRepository.findById(professionalId);
  odontogramRepository.createState({
    patient_id: patientId, tooth: d.tooth, surface: d.surface, kind: d.kind,
    condition_id: condicao.id, note: d.note, recorded_at: quando(d.dias, '10:00'),
    professional_id: professionalId,
    professional_name_snapshot: profissional?.name ?? null,
    professional_cro_snapshot: profissional?.cro ?? null,
    created_by: null,
  });
  return 1;
}

function garantirPlano(
  p: DemoPlano, patientId: number, professionalId: number,
): { id: number; criado: boolean; itens: number } {
  const existente = treatmentPlanRepository.rawOne(
    `SELECT id FROM odonto_treatment_plans
      WHERE patient_id = ? AND title = ? AND deleted_at IS NULL LIMIT 1`, patientId, p.title,
  ) as { id: number } | undefined;
  if (existente) return { id: Number(existente.id), criado: false, itens: 0 };

  const profissional = professionalRepository.findById(professionalId);
  const planId = treatmentPlanRepository.createPlan({
    patient_id: patientId, professional_id: professionalId, title: p.title, status: p.status,
    notes: p.notes, professional_name_snapshot: profissional?.name ?? null,
    professional_cro_snapshot: profissional?.cro ?? null, created_by: null,
  });
  // `createPlan` não recebe as datas de transição; sem elas a tela mostraria um plano "aprovado"
  // sem data de aprovação — incoerência que o usuário veria na primeira olhada.
  treatmentPlanRepository.rawRun(
    `UPDATE odonto_treatment_plans
        SET presented_at = ?, approved_at = ?, started_at = ?, finished_at = ?
      WHERE id = ?`,
    p.diasApresentado == null ? null : quando(p.diasApresentado, '11:00'),
    p.diasAprovado == null ? null : quando(p.diasAprovado, '11:30'),
    p.diasInicio == null ? null : quando(p.diasInicio, '11:45'),
    p.diasFim == null ? null : quando(p.diasFim, '16:00'),
    planId,
  );

  p.items.forEach((item, i) => {
    const procedimento = procedureRepository.findByCode(item.procedimento);
    treatmentPlanRepository.createItem({
      plan_id: planId, procedure_id: procedimento ? procedimento.id : null, tooth: item.tooth,
      description: item.description, amount_cents: item.amount, quantity: item.quantity,
      professional_id: professionalId, status: item.status, sort_order: i * 10, notes: null,
    });
  });
  return { id: planId, criado: true, itens: p.items.length };
}

function garantirDocumento(
  d: DemoDocumento, patientId: number, professionalId: number, planId: number | null,
): number {
  const existente = documentRepository.rawOne(
    `SELECT id FROM odonto_documents WHERE patient_id = ? AND title = ? AND deleted_at IS NULL LIMIT 1`,
    patientId, d.title,
  ) as { id: number } | undefined;
  if (existente) return 0;

  const profissional = professionalRepository.findById(professionalId);
  const template = d.code ? documentRepository.findTemplateByCode(d.code) : undefined;
  const cliente = patientRepository.rawOne(
    'SELECT c.name FROM odonto_patients p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?',
    patientId,
  ) as { name: string } | undefined;
  const corpo = d.corpo(
    cliente?.name ?? 'Paciente', profissional?.name ?? 'Profissional', profissional?.cro ?? '—',
  );

  const id = documentRepository.createDocument({
    patient_id: patientId, appointment_id: null, plan_id: planId,
    template_id: template ? template.id : null, type: d.type, title: d.title, body: corpo,
    status: d.status, version: 1, replaces_id: null, missing_variables_json: null,
    professional_id: professionalId,
    professional_name_snapshot: profissional?.name ?? null,
    professional_cro_snapshot: profissional?.cro ?? null,
    created_by: null,
  });
  if (d.status === 'emitido') {
    // Documento emitido sem data de emissão apareceria como "emitido" e nada mais na lista.
    documentRepository.rawRun(
      `UPDATE odonto_documents SET issued_at = ? WHERE id = ?`, quando(d.dias, '12:00'), id,
    );
  }
  return 1;
}

function garantirEvolucao(
  e: DemoEvolucao, patientId: number, professionalId: number, anteriores: number[],
): { id: number; criada: boolean } {
  const happened = quando(e.dias, e.hora);
  const existente = clinicalNoteRepository.rawOne(
    `SELECT id FROM odonto_clinical_notes
      WHERE patient_id = ? AND happened_at = ? AND title IS ? AND deleted_at IS NULL LIMIT 1`,
    patientId, happened, e.title,
  ) as { id: number } | undefined;
  if (existente) return { id: Number(existente.id), criada: false };

  const profissional = professionalRepository.findById(professionalId);
  const procedimentos = e.procedimentos.flatMap((p) => {
    const proc = procedureRepository.findByCode(p.code);
    if (!proc) return [];
    return [{ procedure_id: Number(proc.id), name: String(proc.name), tooth: p.tooth, note: p.note ?? null }];
  });

  const retificaId = e.retifica == null ? null : anteriores[e.retifica] ?? null;
  const id = clinicalNoteRepository.create({
    patient_id: patientId, professional_id: professionalId, appointment_id: null,
    happened_at: happened, title: e.title, procedures_json: JSON.stringify(procedimentos),
    observations: e.observations, diagnosis: e.diagnosis, conduct: e.conduct, next_steps: e.next,
    documents_json: '[]', exams_json: '[]',
    status: retificaId == null ? 'vigente' : 'retificado',
    version: retificaId == null ? 1 : 2,
    replaced_by_id: null, retifica_id: retificaId,
    retification_reason: retificaId == null
      ? null
      : 'Correção do dente registrado: a radiografia mostrou que a lesão era no 26, não no 16.',
    professional_name_snapshot: profissional?.name ?? null,
    professional_cro_snapshot: profissional?.cro ?? null,
    created_by: null,
  });

  // A versão nova aponta para a antiga; a antiga recebe o `replaced_by_id` aqui, fechando a cadeia
  // exatamente como o serviço de retificação faz.
  if (retificaId != null) clinicalNoteRepository.marcarRetificado(retificaId, id);
  return { id, criada: true };
}

function garantirExame(
  ex: DemoExame, patientId: number, professionalId: number, planId: number | null,
  arquivosGravados: string[],
): number {
  const existente = examRepository.rawOne(
    `SELECT id FROM odonto_exams WHERE patient_id = ? AND title = ? AND deleted_at IS NULL LIMIT 1`,
    patientId, ex.title,
  ) as { id: number } | undefined;
  if (existente) return 0;

  const buffer = ex.arquivo.conteudo();
  const gravado = saveExamFile(ex.arquivo.nome, buffer.toString('base64'), ex.arquivo.mime);
  if (!gravado.ok) {
    // Falha de arquivo aborta a demonstração inteira (a transação desfaz): uma clínica de exemplo
    // com exames sem imagem é pior que nenhuma, porque parece que o módulo está quebrado.
    throw new Error(`Demonstração do Odonto: não foi possível gravar "${ex.arquivo.nome}" — ${gravado.error}`);
  }
  arquivosGravados.push(gravado.file);

  examRepository.createExam({
    patient_id: patientId, appointment_id: null, plan_id: planId, professional_id: professionalId,
    type: ex.type, phase: ex.phase, exam_date: dia(ex.dias), tooth: ex.tooth, title: ex.title,
    description: ex.description, file_name: gravado.file, original_name: gravado.name,
    mime: gravado.mime, size_bytes: gravado.size, created_by: null,
  });
  return 1;
}

// ─────────────────────────────── Entrada ───────────────────────────────

/**
 * Cria (ou completa) a clínica de exemplo. Tudo numa transação: se qualquer passo falhar, o banco
 * volta ao estado anterior e os arquivos de exame já gravados são apagados — meia demonstração
 * confunde mais do que nenhuma.
 */
export function createOdontoDemoData(): OdontoDemoSummary {
  // Os catálogos semeados no boot dos módulos (formulário de anamnese, situações do odontograma e
  // modelos de documento) são pré-requisito do que vem abaixo. Chamar aqui é barato e idempotente
  // (cada um só cria se não existir nada) — e deixa o gerador de pé num banco de teste que nunca
  // subiu o servidor completo.
  ensureDefaultTemplate();
  ensureDefaultConditions();
  ensureDefaultTemplates();

  const resumo: OdontoDemoSummary = {
    profissionais: 0, pacientes: 0, pacientesIgnorados: 0, procedimentos: 0, anamneses: 0,
    agendamentos: 0, evolucoes: 0, estadosOdontograma: 0, planos: 0, itensPlano: 0,
    documentos: 0, exames: 0,
  };
  const arquivosGravados: string[] = [];

  try {
    patientRepository.transaction(() => {
      const profissionais = PROFISSIONAIS.map((p) => {
        const r = garantirProfissional(p);
        if (r.criado) resumo.profissionais++;
        return r.id;
      });

      const procedimentos = new Map<string, number>();
      for (const p of PROCEDIMENTOS) {
        const r = garantirProcedimento(p);
        procedimentos.set(p.code, r.id);
        if (r.criado) resumo.procedimentos++;
      }

      const template = anamnesisRepository.defaultTemplate();
      const pacientes: (number | null)[] = PACIENTES.map((p) => {
        const r = garantirPaciente(p);
        if (r == null) { resumo.pacientesIgnorados++; return null; }
        if (r.criado) resumo.pacientes++;
        if (template) {
          resumo.anamneses += garantirAnamnese(
            r.id, Number(template.id), Number(template.version), profissionais[0],
          );
        }
        return r.id;
      });

      // Agenda antes de prontuário e exames: os registros clínicos citam atendimentos na tela, e
      // uma agenda vazia faria a demonstração parecer quebrada.
      for (const a of AGENDA) {
        const patientId = pacientes[a.paciente];
        if (patientId == null) continue;
        resumo.agendamentos += criarAgendamento(
          a, patientId, profissionais[a.profissional], procedimentos.get(a.procedimento) ?? null,
        );
      }

      for (const d of DENTES) {
        const patientId = pacientes[d.paciente];
        if (patientId == null) continue;
        resumo.estadosOdontograma += garantirDente(d, patientId, profissionais[0]);
      }

      // Os planos guardam o id por ÍNDICE: os documentos e exames abaixo apontam para "o plano 1"
      // sem precisar procurar de novo por título.
      const planos: number[] = PLANOS.map((p) => {
        const patientId = pacientes[p.paciente];
        if (patientId == null) return 0;
        const r = garantirPlano(p, patientId, profissionais[p.profissional]);
        if (r.criado) { resumo.planos++; resumo.itensPlano += r.itens; }
        return r.id;
      });

      for (const d of DOCUMENTOS) {
        const patientId = pacientes[d.paciente];
        if (patientId == null) continue;
        const planId = d.plano == null ? null : planos[d.plano] || null;
        resumo.documentos += garantirDocumento(d, patientId, profissionais[d.profissional], planId);
      }

      const evolucoes: number[] = [];
      for (const e of EVOLUCOES) {
        const patientId = pacientes[e.paciente];
        if (patientId == null) { evolucoes.push(0); continue; }
        const r = garantirEvolucao(e, patientId, profissionais[e.profissional], evolucoes);
        if (r.criada) resumo.evolucoes++;
        evolucoes.push(r.id);
      }

      for (const ex of EXAMES) {
        const patientId = pacientes[ex.paciente];
        if (patientId == null) continue;
        const planId = ex.plano == null ? null : planos[ex.plano] || null;
        resumo.exames += garantirExame(
          ex, patientId, profissionais[ex.profissional], planId, arquivosGravados,
        );
      }
    });
  } catch (erro) {
    // O rollback já aconteceu; os arquivos é que ficariam órfãos no disco.
    for (const arquivo of arquivosGravados) deleteExamFile(arquivo);
    throw erro;
  }

  return resumo;
}
