import type { ModuleManifest } from '../../core/modules/types';

/**
 * Módulo odonto — Kivo Odonto: gestão de consultórios e clínicas odontológicas.
 *
 * Filosofia da plataforma ("ligue somente o que você precisa"): o módulo NÃO duplica o que o
 * Core já entrega. Paciente é um cliente (`customers`) + ficha clínica; procedimento pode
 * apontar para um produto/serviço do catálogo; cobrança do tratamento usa o financeiro
 * existente; material e medicamento usam o estoque com lote/validade do commercial.
 *
 * A auditoria que fundamenta estas escolhas está em
 * `doc/KIVO_ODONTO_ARCHITECTURE_AUDIT.md` (arquivo:linha de cada decisão).
 *
 * Fase atual (fundação + pacientes + anamnese + agenda): pacientes, profissionais,
 * procedimentos, anamnese versionada e agenda de atendimentos.
 * Nenhuma tabela do módulo entra em `syncTables` nesta versão — dado clínico fica na máquina
 * que o produziu (decisão registrada na auditoria, seções 10 e 19). As capabilities de
 * agenda/odontograma/documentos/exames entram junto com cada tela, para não existir recurso
 * ligável que não faz nada.
 */
const manifest: ModuleManifest = {
  id: 'odonto',
  name: 'Odonto (clínicas e consultórios)',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  // Usa o serviço `commercial.customers` para criar/atualizar o cliente que ancora o paciente.
  dependsOn: ['commercial'],
  permissions: [
    { key: 'odonto.patients.view', description: 'Ver a lista e a ficha cadastral de pacientes' },
    { key: 'odonto.patients.create', description: 'Cadastrar paciente' },
    { key: 'odonto.patients.edit', description: 'Editar dados cadastrais do paciente' },
    { key: 'odonto.patients.delete', description: 'Excluir a ficha do paciente (o cadastro de cliente permanece)' },
    { key: 'odonto.clinical.view', description: 'Ver o conteúdo clínico do paciente (alergias, histórico médico, medicações)' },
    { key: 'odonto.clinical.edit', description: 'Registrar e alterar o conteúdo clínico do paciente' },
    { key: 'odonto.clinical.retify', description: 'Retificar registro clínico já assinado (correção com motivo, preservando o histórico)' },
    { key: 'odonto.professionals.view', description: 'Ver os profissionais do consultório' },
    { key: 'odonto.professionals.manage', description: 'Cadastrar, editar e excluir profissionais (CRO e especialidades)' },
    { key: 'odonto.procedures.view', description: 'Ver o catálogo de procedimentos odontológicos' },
    { key: 'odonto.procedures.manage', description: 'Cadastrar, editar e excluir procedimentos odontológicos' },
    { key: 'odonto.agenda.view', description: 'Ver a agenda de atendimentos (dia, semana e mês)' },
    { key: 'odonto.agenda.manage', description: 'Agendar, reagendar, confirmar, registrar atendimento ou falta e cancelar' },
    { key: 'odonto.plans.view', description: 'Ver os planos de tratamento do paciente (itens, dentes e valores)' },
    { key: 'odonto.plans.manage', description: 'Criar, editar, aprovar e concluir planos de tratamento' },
    { key: 'odonto.plans.charge', description: 'Gerar a cobrança do plano aprovado no Financeiro' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    {
      label: 'Agenda',
      href: '/app/odonto/agenda',
      permission: 'odonto.agenda.view',
      description: 'Atendimentos do dia, da semana e do mês, com confirmação e registro de falta.',
      icon: 'calendar',
    },
    {
      label: 'Pacientes',
      href: '/app/odonto/pacientes',
      permission: 'odonto.patients.view',
      description: 'Cadastro e ficha do paciente do consultório.',
      icon: 'users',
    },
    {
      label: 'Profissionais',
      href: '/app/odonto/profissionais',
      permission: 'odonto.professionals.view',
      description: 'Dentistas e auxiliares que atendem, com CRO e especialidades.',
      icon: 'user-cog',
    },
    {
      label: 'Procedimentos',
      href: '/app/odonto/procedimentos',
      permission: 'odonto.procedures.view',
      description: 'Catálogo de procedimentos, valores e duração estimada.',
      icon: 'clipboard',
    },
  ],
};

export default manifest;
