import { BaseRepository, type Row } from '../../../core/database/repository';
import { stableUuid } from '../../../shared/uuid';

/** Tipos de pergunta aceitos no formulário de anamnese. */
export type AnamnesisFieldType = 'texto' | 'texto_longo' | 'sim_nao' | 'selecao' | 'multipla' | 'data' | 'numero';

export interface AnamnesisField {
  /** Chave da resposta (`answers_json`). Estável entre versões do formulário. */
  key: string;
  label: string;
  type: AnamnesisFieldType;
  required?: boolean;
  /** Só para `selecao` e `multipla`. */
  options?: string[];
  help?: string;
}

export interface AnamnesisTemplateRow extends Row {
  id: number;
  name: string;
  version: number;
  fields_json: string;
  notes: string | null;
  active: number;
  is_default: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

export interface AnamnesisFormRow extends Row {
  id: number;
  patient_id: number;
  template_id: number;
  template_version: number;
  revision: number;
  answers_json: string;
  professional_id: number | null;
  filled_by: number | null;
  filled_at: string;
  notes: string | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Resposta já com o nome de quem preencheu e do profissional (para a tela). */
export interface AnamnesisFormDetail extends AnamnesisFormRow {
  template_name: string;
  filled_by_name: string | null;
  professional_name: string | null;
}

export interface AnamnesisSummary {
  revisions: number;
  last_filled_at: string | null;
  last_revision: number | null;
  last_template_name: string | null;
}

class AnamnesisRepository extends BaseRepository<AnamnesisTemplateRow> {
  constructor() {
    super('odonto_anamnesis_templates');
  }

  // ───────────────────────────── Formulários (templates) ─────────────────────────────

  /**
   * Versão mais recente de cada formulário. O histórico de versões continua na tabela: quem
   * respondeu na versão 1 continua apontando para ela.
   */
  listLatestTemplates(activeOnly = true): AnamnesisTemplateRow[] {
    return this.raw(
      `SELECT t.* FROM odonto_anamnesis_templates t
        WHERE t.deleted_at IS NULL
          ${activeOnly ? 'AND t.active = 1' : ''}
          AND t.version = (
            SELECT MAX(v.version) FROM odonto_anamnesis_templates v
             WHERE v.name = t.name AND v.deleted_at IS NULL
          )
        ORDER BY t.is_default DESC, t.name`,
    ) as unknown as AnamnesisTemplateRow[];
  }

  /** Todas as versões de um formulário, da mais nova para a mais antiga. */
  listVersions(name: string): AnamnesisTemplateRow[] {
    return this.raw(
      `SELECT * FROM odonto_anamnesis_templates
        WHERE name = ? AND deleted_at IS NULL ORDER BY version DESC`,
      name,
    ) as unknown as AnamnesisTemplateRow[];
  }

  findTemplate(id: number): AnamnesisTemplateRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_anamnesis_templates WHERE id = ? AND deleted_at IS NULL',
      id,
    ) as unknown as AnamnesisTemplateRow | undefined;
  }

  defaultTemplate(): AnamnesisTemplateRow | undefined {
    return this.rawOne(
      `SELECT * FROM odonto_anamnesis_templates
        WHERE is_default = 1 AND active = 1 AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1`,
    ) as unknown as AnamnesisTemplateRow | undefined;
  }

  maxVersion(name: string): number {
    const row = this.rawOne(
      'SELECT COALESCE(MAX(version), 0) AS v FROM odonto_anamnesis_templates WHERE name = ? AND deleted_at IS NULL',
      name,
    ) as { v: number } | undefined;
    return Number(row?.v ?? 0);
  }

  /** Cria a versão seguinte (ou o primeiro formulário) e devolve o id. */
  createTemplate(data: {
    name: string;
    version: number;
    fields_json: string;
    notes: string | null;
    active: number;
    is_default: number;
  }): number {
    return Number(this.rawRun(
      `INSERT INTO odonto_anamnesis_templates (name, version, fields_json, notes, active, is_default, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.name, data.version, data.fields_json, data.notes, data.active, data.is_default,
      stableUuid(`odonto_anamnesis_template:${data.name}:${data.version}`),
    ).lastInsertRowid);
  }

  /** Só um formulário é o padrão do consultório. */
  clearDefaultTemplates(exceptId?: number): void {
    this.rawRun(
      `UPDATE odonto_anamnesis_templates SET is_default = 0, updated_at = datetime('now')
        WHERE is_default = 1 ${exceptId ? 'AND id <> ?' : ''}`,
      ...(exceptId ? [exceptId] : []),
    );
  }

  updateTemplate(id: number, patch: { active?: number; is_default?: number; notes?: string | null }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active); }
    if (patch.is_default !== undefined) { sets.push('is_default = ?'); params.push(patch.is_default); }
    if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes); }
    if (!sets.length) return;
    this.rawRun(
      `UPDATE odonto_anamnesis_templates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...params, id,
    );
  }

  // ─────────────────────────────── Respostas ───────────────────────────────

  /** Revisões de um paciente, da mais nova para a mais antiga (opcionalmente de um formulário). */
  listForms(patientId: number, templateId?: number): AnamnesisFormDetail[] {
    return this.raw(
      `SELECT f.*, t.name AS template_name, u.username AS filled_by_name, p.name AS professional_name
         FROM odonto_anamnesis_forms f
         JOIN odonto_anamnesis_templates t ON t.id = f.template_id
         LEFT JOIN users u ON u.id = f.filled_by
         LEFT JOIN odonto_professionals p ON p.id = f.professional_id
        WHERE f.patient_id = ? AND f.deleted_at IS NULL
          ${templateId ? 'AND f.template_id = ?' : ''}
        ORDER BY f.revision DESC`,
      ...(templateId ? [patientId, templateId] : [patientId]),
    ) as unknown as AnamnesisFormDetail[];
  }

  findForm(id: number): AnamnesisFormDetail | undefined {
    return this.rawOne(
      `SELECT f.*, t.name AS template_name, u.username AS filled_by_name, p.name AS professional_name
         FROM odonto_anamnesis_forms f
         JOIN odonto_anamnesis_templates t ON t.id = f.template_id
         LEFT JOIN users u ON u.id = f.filled_by
         LEFT JOIN odonto_professionals p ON p.id = f.professional_id
        WHERE f.id = ? AND f.deleted_at IS NULL`,
      id,
    ) as unknown as AnamnesisFormDetail | undefined;
  }

  latestForm(patientId: number, templateId?: number): AnamnesisFormDetail | undefined {
    return this.rawOne(
      `SELECT f.*, t.name AS template_name, u.username AS filled_by_name, p.name AS professional_name
         FROM odonto_anamnesis_forms f
         JOIN odonto_anamnesis_templates t ON t.id = f.template_id
         LEFT JOIN users u ON u.id = f.filled_by
         LEFT JOIN odonto_professionals p ON p.id = f.professional_id
        WHERE f.patient_id = ? AND f.deleted_at IS NULL ${templateId ? 'AND f.template_id = ?' : ''}
        ORDER BY f.revision DESC, f.id DESC LIMIT 1`,
      ...(templateId ? [patientId, templateId] : [patientId]),
    ) as unknown as AnamnesisFormDetail | undefined;
  }

  /**
   * Última revisão da anamnese DESTE paciente. A numeração é do paciente, não do formulário:
   * trocar a versão do formulário no meio do acompanhamento não faz a revisão voltar para 1.
   */
  maxRevision(patientId: number): number {
    const row = this.rawOne(
      `SELECT COALESCE(MAX(revision), 0) AS r FROM odonto_anamnesis_forms
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    ) as { r: number } | undefined;
    return Number(row?.r ?? 0);
  }

  /** Grava a revisão. Devolve o id — o histórico anterior não é tocado. */
  createForm(data: {
    patient_id: number;
    template_id: number;
    template_version: number;
    revision: number;
    answers_json: string;
    professional_id: number | null;
    filled_by: number | null;
    notes: string | null;
  }): number {
    return Number(this.rawRun(
      `INSERT INTO odonto_anamnesis_forms
         (patient_id, template_id, template_version, revision, answers_json, professional_id, filled_by, notes, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.patient_id, data.template_id, data.template_version, data.revision, data.answers_json,
      data.professional_id, data.filled_by, data.notes,
      stableUuid(`odonto_anamnesis_form:${data.patient_id}:${data.template_id}:${data.revision}`),
    ).lastInsertRowid);
  }

  summary(patientId: number): AnamnesisSummary {
    const row = this.rawOne(
      `SELECT COUNT(*) AS revisions, MAX(f.filled_at) AS last_filled_at,
              (SELECT f2.revision FROM odonto_anamnesis_forms f2
                WHERE f2.patient_id = f.patient_id AND f2.deleted_at IS NULL
                ORDER BY f2.revision DESC LIMIT 1) AS last_revision,
              (SELECT t.name FROM odonto_anamnesis_forms f3
                 JOIN odonto_anamnesis_templates t ON t.id = f3.template_id
                WHERE f3.patient_id = f.patient_id AND f3.deleted_at IS NULL
                ORDER BY f3.revision DESC LIMIT 1) AS last_template_name
         FROM odonto_anamnesis_forms f
        WHERE f.patient_id = ? AND f.deleted_at IS NULL`,
      patientId,
    ) as { revisions: number; last_filled_at: string | null; last_revision: number | null; last_template_name: string | null } | undefined;
    return {
      revisions: Number(row?.revisions ?? 0),
      last_filled_at: row?.last_filled_at ?? null,
      last_revision: row?.last_revision != null ? Number(row.last_revision) : null,
      last_template_name: row?.last_template_name ?? null,
    };
  }

  /** Excluir o paciente leva junto a anamnese dele (soft delete, como o resto do módulo). */
  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_anamnesis_forms
          SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }
}

export const anamnesisRepository = new AnamnesisRepository();
