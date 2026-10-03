import type { Request } from 'express';
import { assertAuth } from '../../shared/auth';
import { appointmentRepository } from './repositories/AppointmentRepository';
import { reportRepository } from './repositories/ReportRepository';
import { documentRepository } from './repositories/DocumentRepository';
import { treatmentPlanRepository } from './repositories/TreatmentPlanRepository';
import type { Result } from './permissions';

/**
 * Painel e relatórios do Kivo Odonto (fase 9, PR §21 e §27).
 *
 * Princípio que vale para tudo aqui: o painel CONTA e SOMA, nunca mostra texto clínico. Quem lê
 * evolução, anamnese ou documento é a tela do prontuário, com `odonto.clinical.view`. Um painel
 * que vaza "observações do atendimento" para quem só tem relatório seria um vazamento de dado
 * de saúde (PR §25).
 *
 * A auditoria NÃO é reimplementada: a trilha do Core (`/admin/auditoria`, permissão
 * `audit.view`) já lista `odonto_*` como qualquer outra entidade — o painel só aponta para lá.
 */

export const PERM_REPORTS_VIEW = 'odonto.reports.view';

function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

function periodoPadrao(inicio?: unknown, fim?: unknown): { from: string; to: string } {
  const f = String(fim ?? '') || hoje();
  const i = String(inicio ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(i) && /^\d{4}-\d{2}-\d{2}$/.test(f)) return { from: i, to: f };
  // Sem período informado: do primeiro dia do mês até hoje (o recorte que o consultório usa).
  return { from: f.slice(0, 8) + '01', to: f };
}

export interface DashboardOutput {
  hoje: string;
  pacientes: { ativos: number; novos_mes: number; sem_anamnese: number };
  agenda: { total: number; por_status: { status: string; total: number }[] };
  proximos: { id: number; starts_at: string; status: string; patient_name: string; professional_name: string | null }[];
  planos: {
    abertos: number; valor_aberto_cents: number; aprovados: number; concluidos: number;
    cobrados: number; valor_cobrado_cents: number;
  };
  odontograma: { dentes_avaliados: number; registros: number };
  documentos: { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null };
  documentos_do_mes: { total: number; por_tipo: { type: string; total: number; emitidos: number }[] };
}

export function dashboard(req: Request): Result<DashboardOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_REPORTS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_REPORTS_VIEW}`, status: 403 };
  }
  const dia = hoje();
  const mes = periodoPadrao(undefined, dia);
  const agenda = reportRepository.agendaDoDia(dia);
  return {
    ok: true,
    data: {
      hoje: dia,
      pacientes: reportRepository.pacientes(),
      agenda,
      proximos: reportRepository.proximosAtendimentos(`${dia} 00:00`, 8),
      planos: reportRepository.planos(mes.from, mes.to),
      odontograma: reportRepository.odontograma(),
      documentos: documentsSummary(),
      documentos_do_mes: { total: 0, por_tipo: documentRepository.countByType(mes.from, mes.to) },
    },
  };
}

/** Totais de documento da clínica inteira (não de um paciente) — para o painel. */
function documentsSummary(): { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null } {
  const emitidosNoMes = documentRepository.emitidosEntre(hoje().slice(0, 8) + '01', hoje());
  return {
    total: emitidosNoMes,
    emitidos: emitidosNoMes,
    rascunhos: 0,
    ultimo_em: null,
  };
}

export type ReportType = 'atendimentos' | 'producao' | 'planos' | 'documentos' | 'anamnese' | 'pacientes';

export const REPORT_TYPES: { type: ReportType; label: string; descricao: string }[] = [
  { type: 'atendimentos', label: 'Atendimentos', descricao: 'Consultas do período por situação e por profissional, com faltas.' },
  { type: 'producao', label: 'Produção realizada', descricao: 'Procedimentos registrados nas evoluções, por procedimento e por profissional.' },
  { type: 'planos', label: 'Planos de tratamento', descricao: 'Planos criados no período por situação, com valor.' },
  { type: 'documentos', label: 'Documentos', descricao: 'Documentos gerados no período por tipo.' },
  { type: 'anamnese', label: 'Anamnese', descricao: 'Quantos pacientes responderam a anamnese no período.' },
  { type: 'pacientes', label: 'Pacientes', descricao: 'Situação da carteira de pacientes.' },
];

export interface ReportOutput {
  type: ReportType;
  label: string;
  from: string;
  to: string;
  colunas: { key: string; label: string; money?: boolean }[];
  linhas: Record<string, string | number>[];
  totais?: Record<string, number>;
}

export function report(req: Request, tipo: string, inicio?: unknown, fim?: unknown): Result<ReportOutput> {
  assertAuth(req);
  if (!req.user?.permissions.has(PERM_REPORTS_VIEW)) {
    return { ok: false, error: `Permissão negada: ${PERM_REPORTS_VIEW}`, status: 403 };
  }
  const { from, to } = periodoPadrao(inicio, fim);
  const meta = REPORT_TYPES.find((r) => r.type === tipo);
  if (!meta) return { ok: false, error: `Relatório inválido: use ${REPORT_TYPES.map((r) => r.type).join(', ')}.`, status: 400 };
  const base = { type: meta.type, label: meta.label, from, to };

  switch (meta.type) {
    case 'atendimentos': {
      const porStatus = reportRepository.atendimentosPorStatus(from, to);
      const porProfissional = reportRepository.atendimentosPorProfissional(from, to);
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'grupo', label: 'Grupo' },
            { key: 'nome', label: 'Situação / profissional' },
            { key: 'total', label: 'Total' },
            { key: 'atendidos', label: 'Atendidos' },
            { key: 'faltas', label: 'Faltas' },
          ],
          linhas: [
            ...porStatus.map((r) => ({ grupo: 'Situação', nome: r.status, total: Number(r.total), atendidos: '', faltas: '' })),
            ...porProfissional.map((r) => ({
              grupo: 'Profissional', nome: r.professional_name,
              total: Number(r.total), atendidos: Number(r.atendidos), faltas: Number(r.faltas),
            })),
          ],
          totais: { total: porStatus.reduce((s, r) => s + Number(r.total), 0) },
        },
      };
    }
    case 'producao': {
      const porProcedimento = reportRepository.producaoPorProcedimento(from, to);
      const porProfissional = reportRepository.producaoPorProfissional(from, to);
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'grupo', label: 'Grupo' },
            { key: 'nome', label: 'Procedimento / profissional' },
            { key: 'total', label: 'Quantidade' },
            { key: 'valor_cents', label: 'Valor de tabela', money: true },
          ],
          linhas: [
            ...porProcedimento.map((r) => ({ grupo: 'Procedimento', nome: r.name, total: Number(r.total), valor_cents: Number(r.valor_cents) })),
            ...porProfissional.map((r) => ({ grupo: 'Profissional', nome: r.professional_name, total: Number(r.total), valor_cents: '' })),
          ],
          totais: {
            total: porProcedimento.reduce((s, r) => s + Number(r.total), 0),
            valor_cents: porProcedimento.reduce((s, r) => s + Number(r.valor_cents), 0),
          },
        },
      };
    }
    case 'planos': {
      const linhas = reportRepository.planosPorStatus(from, to);
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'status', label: 'Situação' },
            { key: 'total', label: 'Planos' },
            { key: 'valor_cents', label: 'Valor', money: true },
          ],
          linhas: linhas.map((r) => ({ status: r.status, total: Number(r.total), valor_cents: Number(r.valor_cents) })),
          totais: {
            total: linhas.reduce((s, r) => s + Number(r.total), 0),
            valor_cents: linhas.reduce((s, r) => s + Number(r.valor_cents), 0),
          },
        },
      };
    }
    case 'documentos': {
      const linhas = documentRepository.countByType(from, to);
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'tipo', label: 'Tipo' },
            { key: 'total', label: 'Gerados' },
            { key: 'emitidos', label: 'Emitidos' },
          ],
          linhas: linhas.map((r) => ({ tipo: r.type, total: Number(r.total), emitidos: Number(r.emitidos) })),
          totais: {
            total: linhas.reduce((s, r) => s + Number(r.total), 0),
            emitidos: linhas.reduce((s, r) => s + Number(r.emitidos), 0),
          },
        },
      };
    }
    case 'anamnese': {
      const r = reportRepository.anamneseNoPeriodo(from, to);
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'metrica', label: 'Métrica' },
            { key: 'valor', label: 'Valor' },
          ],
          linhas: [
            { metrica: 'Respostas registradas', valor: r.total },
            { metrica: 'Pacientes que responderam', valor: r.pacientes },
          ],
          totais: { total: r.total },
        },
      };
    }
    default: {
      const p = reportRepository.pacientes();
      return {
        ok: true,
        data: {
          ...base,
          colunas: [
            { key: 'metrica', label: 'Métrica' },
            { key: 'valor', label: 'Valor' },
          ],
          linhas: [
            { metrica: 'Pacientes ativos', valor: p.ativos },
            { metrica: 'Novos no mês', valor: p.novos_mes },
            { metrica: 'Sem anamnese respondida', valor: p.sem_anamnese },
          ],
          totais: { total: p.ativos },
        },
      };
    }
  }
}

/** CSV do relatório (o "exportar" do sistema é CSV, como no resto do Kivo). */
export function reportCsv(dados: ReportOutput): string {
  const dinheiro = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
  const cabecalho = dados.colunas.map((c) => c.label).join(';');
  const linhas = dados.linhas.map((linha) => dados.colunas.map((c) => {
    const v = linha[c.key];
    if (v === undefined || v === null) return '';
    if (c.money && typeof v === 'number') return dinheiro(v);
    return String(v).replace(/;/g, ',');
  }).join(';'));
  const totais = dados.totais
    ? ['', ...dados.colunas.slice(1).map((c) => (dados.totais?.[c.key] !== undefined
      ? (c.money ? dinheiro(Number(dados.totais[c.key])) : String(dados.totais[c.key])) : ''))].join(';')
    : '';
  return [
    `Relatório: ${dados.label}`,
    `Período: ${dados.from} a ${dados.to}`,
    '',
    cabecalho,
    ...linhas,
    ...(totais ? ['', `TOTAIS;${totais.replace(/^;/, '')}`] : []),
  ].join('\r\n');
}

/** Resumo do paciente para a ficha (mantido aqui para a tela não precisar de outra chamada). */
export function patientSummary(patientId: number): { planos: unknown; documentos: unknown } {
  return {
    planos: treatmentPlanRepository.resumo(patientId),
    documentos: documentRepository.resumo(patientId),
  };
}

/** Contagem de atendimentos por dia (usada no painel/relatório de agenda). */
export function atendimentosPorDia(from: string, to: string, professionalId?: number): { dia: string; total: number; pendentes: number }[] {
  return appointmentRepository.contagemPorDia(from, to, professionalId);
}
