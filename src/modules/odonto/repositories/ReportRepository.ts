import { BaseRepository, type Row } from '../../../core/database/repository';

/**
 * Consultas de agregação do painel e dos relatórios (fase 9, PR §21).
 *
 * Só lê: nada aqui grava. Fica num repositório próprio para as agregações não se misturarem com
 * as regras de paciente/agenda/plano — e porque `raw`/`rawOne` são a porta de SQL do módulo.
 *
 * Regra de ouro seguida em todas as consultas: **nenhum texto clínico** sai daqui (nada de
 * `observations`, `body` de documento ou texto de anamnese). O painel conta e soma; quem lê
 * conteúdo é a tela do prontuário, com permissão clínica.
 */
class ReportRepository extends BaseRepository<Row> {
  constructor() {
    super('odonto_patients');
  }

  // ─────────────────────────────── Painel ───────────────────────────────

  pacientes(): { ativos: number; novos_mes: number; sem_anamnese: number } {
    const row = this.rawOne(
      `SELECT
         (SELECT COUNT(*) FROM odonto_patients WHERE deleted_at IS NULL AND active = 1) AS ativos,
         (SELECT COUNT(*) FROM odonto_patients
           WHERE deleted_at IS NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')) AS novos_mes,
         (SELECT COUNT(*) FROM odonto_patients p
           WHERE p.deleted_at IS NULL AND p.active = 1
             AND NOT EXISTS (SELECT 1 FROM odonto_anamnesis_forms a
                              WHERE a.patient_id = p.id AND a.deleted_at IS NULL)) AS sem_anamnese`,
    ) as { ativos: number; novos_mes: number; sem_anamnese: number } | undefined;
    return {
      ativos: Number(row?.ativos ?? 0),
      novos_mes: Number(row?.novos_mes ?? 0),
      sem_anamnese: Number(row?.sem_anamnese ?? 0),
    };
  }

  agendaDoDia(dia: string): { total: number; por_status: { status: string; total: number }[] } {
    const porStatus = this.raw(
      `SELECT status, COUNT(*) AS total FROM odonto_appointments
        WHERE deleted_at IS NULL AND date(starts_at) = ? GROUP BY status`,
      dia,
    ) as unknown as { status: string; total: number }[];
    return { total: porStatus.reduce((s, r) => s + Number(r.total), 0), por_status: porStatus };
  }

  proximosAtendimentos(desde: string, limite = 8): {
    id: number; starts_at: string; status: string; patient_name: string; professional_name: string | null;
  }[] {
    return this.raw(
      `SELECT a.id, a.starts_at, a.status, c.name AS patient_name, p.name AS professional_name
         FROM odonto_appointments a
         JOIN odonto_patients pa ON pa.id = a.patient_id
         JOIN customers c ON c.id = pa.customer_id
         LEFT JOIN odonto_professionals p ON p.id = a.professional_id
        WHERE a.deleted_at IS NULL AND a.starts_at >= ? AND a.status NOT IN ('cancelado', 'faltou')
        ORDER BY a.starts_at LIMIT ?`,
      desde, limite,
    ) as unknown as { id: number; starts_at: string; status: string; patient_name: string; professional_name: string | null }[];
  }

  /** Planos e dinheiro do odontograma/plano: abertos x cobrados no período. */
  planos(from: string, to: string): {
    abertos: number; valor_aberto_cents: number; aprovados: number; concluidos: number;
    cobrados: number; valor_cobrado_cents: number;
  } {
    const abertos = this.rawOne(
      `SELECT COUNT(*) AS t,
              COALESCE(SUM((SELECT COALESCE(SUM(i.amount_cents * i.quantity), 0)
                              FROM odonto_treatment_items i
                             WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'cancelado')), 0) AS v
         FROM odonto_treatment_plans p
        WHERE p.deleted_at IS NULL AND p.status IN ('planejado', 'apresentado', 'aprovado', 'em_andamento')`,
    ) as { t: number; v: number } | undefined;
    const porStatus = this.raw(
      `SELECT status, COUNT(*) AS total FROM odonto_treatment_plans
        WHERE deleted_at IS NULL AND date(created_at) BETWEEN ? AND ? GROUP BY status`,
      from, to,
    ) as unknown as { status: string; total: number }[];
    const cobrados = this.rawOne(
      `SELECT COUNT(*) AS t, COALESCE(SUM(total), 0) AS v FROM (
         SELECT p.id, COALESCE((SELECT SUM(i.amount_cents * i.quantity) FROM odonto_treatment_items i
                                 WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'cancelado'), 0) AS total
           FROM odonto_treatment_plans p
          WHERE p.deleted_at IS NULL AND p.charged_at IS NOT NULL
            AND date(p.charged_at) BETWEEN ? AND ?)`,
      from, to,
    ) as { t: number; v: number } | undefined;
    const contar = (s: string) => Number(porStatus.find((r) => r.status === s)?.total ?? 0);
    return {
      abertos: Number(abertos?.t ?? 0),
      valor_aberto_cents: Number(abertos?.v ?? 0),
      aprovados: contar('aprovado'),
      concluidos: contar('concluido'),
      cobrados: Number(cobrados?.t ?? 0),
      valor_cobrado_cents: Number(cobrados?.v ?? 0),
    };
  }

  /** Odontograma: quantos dentes têm situação registrada (contagem, não conteúdo). */
  odontograma(): { dentes_avaliados: number; registros: number } {
    const row = this.rawOne(
      `SELECT COUNT(DISTINCT tooth) AS dentes, COUNT(*) AS registros
         FROM odonto_tooth_states WHERE deleted_at IS NULL AND undone_at IS NULL`,
    ) as { dentes: number; registros: number } | undefined;
    return { dentes_avaliados: Number(row?.dentes ?? 0), registros: Number(row?.registros ?? 0) };
  }

  // ──────────────────────────── Relatórios ────────────────────────────

  atendimentosPorStatus(from: string, to: string): { status: string; total: number }[] {
    return this.raw(
      `SELECT status, COUNT(*) AS total FROM odonto_appointments
        WHERE deleted_at IS NULL AND date(starts_at) BETWEEN ? AND ? GROUP BY status ORDER BY total DESC`,
      from, to,
    ) as unknown as { status: string; total: number }[];
  }

  atendimentosPorProfissional(from: string, to: string): { professional_name: string; total: number; atendidos: number; faltas: number }[] {
    return this.raw(
      `SELECT COALESCE(p.name, 'Sem profissional') AS professional_name,
              COUNT(*) AS total,
              SUM(CASE WHEN a.status = 'atendido' THEN 1 ELSE 0 END) AS atendidos,
              SUM(CASE WHEN a.status = 'faltou' THEN 1 ELSE 0 END) AS faltas
         FROM odonto_appointments a
         LEFT JOIN odonto_professionals p ON p.id = a.professional_id
        WHERE a.deleted_at IS NULL AND date(a.starts_at) BETWEEN ? AND ?
        GROUP BY p.id ORDER BY total DESC`,
      from, to,
    ) as unknown as { professional_name: string; total: number; atendidos: number; faltas: number }[];
  }

  /**
   * Produção: procedimentos REALIZADOS saem das evoluções do prontuário (json_each), somando
   * quantidade e valor do catálogo quando o procedimento existe. É a única leitura de produção
   * que toca o prontuário — e devolve nome de procedimento e valores, nunca o texto clínico.
   */
  producaoPorProcedimento(from: string, to: string): { name: string; total: number; valor_cents: number }[] {
    return this.raw(
      `SELECT COALESCE(pr.name, json_extract(j.value, '$.name')) AS name,
              COUNT(*) AS total,
              COALESCE(SUM(COALESCE(pr.default_price_cents, 0)), 0) AS valor_cents
         FROM odonto_clinical_notes n, json_each(n.procedures_json) j
         LEFT JOIN odonto_procedures pr ON pr.id = json_extract(j.value, '$.procedure_id')
        WHERE n.deleted_at IS NULL AND date(n.happened_at) BETWEEN ? AND ?
        GROUP BY name ORDER BY total DESC`,
      from, to,
    ) as unknown as { name: string; total: number; valor_cents: number }[];
  }

  producaoPorProfissional(from: string, to: string): { professional_name: string; total: number }[] {
    return this.raw(
      `SELECT COALESCE(n.professional_name_snapshot, 'Sem profissional') AS professional_name, COUNT(*) AS total
         FROM odonto_clinical_notes n, json_each(n.procedures_json) j
        WHERE n.deleted_at IS NULL AND date(n.happened_at) BETWEEN ? AND ?
        GROUP BY n.professional_name_snapshot ORDER BY total DESC`,
      from, to,
    ) as unknown as { professional_name: string; total: number }[];
  }

  planosPorStatus(from: string, to: string): { status: string; total: number; valor_cents: number }[] {
    return this.raw(
      `SELECT p.status,
              COUNT(*) AS total,
              COALESCE(SUM((SELECT COALESCE(SUM(i.amount_cents * i.quantity), 0)
                              FROM odonto_treatment_items i
                             WHERE i.plan_id = p.id AND i.deleted_at IS NULL AND i.status <> 'cancelado')), 0) AS valor_cents
         FROM odonto_treatment_plans p
        WHERE p.deleted_at IS NULL AND date(p.created_at) BETWEEN ? AND ?
        GROUP BY p.status ORDER BY total DESC`,
      from, to,
    ) as unknown as { status: string; total: number; valor_cents: number }[];
  }

  /** Anamnese: quantos pacientes responderam no período (contagem, sem conteúdo). */
  anamneseNoPeriodo(from: string, to: string): { total: number; pacientes: number } {
    const row = this.rawOne(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT patient_id) AS pacientes
         FROM odonto_anamnesis_forms
        WHERE deleted_at IS NULL AND date(filled_at) BETWEEN ? AND ?`,
      from, to,
    ) as { total: number; pacientes: number } | undefined;
    return { total: Number(row?.total ?? 0), pacientes: Number(row?.pacientes ?? 0) };
  }
}

export const reportRepository = new ReportRepository();
