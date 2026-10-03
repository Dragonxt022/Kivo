import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

/** Tipos de documento da PR §14. */
export const DOCUMENT_TYPES = [
  'anamnese', 'plano_tratamento', 'tcle', 'contrato', 'atestado', 'declaracao',
  'encaminhamento', 'receita', 'termo_responsabilidade', 'termo_recusa', 'alta', 'outro',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  anamnese: 'Anamnese',
  plano_tratamento: 'Plano de tratamento',
  tcle: 'TCLE (consentimento)',
  contrato: 'Contrato',
  atestado: 'Atestado',
  declaracao: 'Declaração',
  encaminhamento: 'Encaminhamento',
  receita: 'Receita',
  termo_responsabilidade: 'Termo de responsabilidade',
  termo_recusa: 'Termo de recusa',
  alta: 'Alta',
  outro: 'Outro documento',
};

export interface DocumentTemplateRow extends Row {
  id: number;
  code: string | null;
  name: string;
  type: DocumentType;
  body: string;
  variables_json: string | null;
  requires_professional: number;
  active: number;
  sort_order: number;
  is_system: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

export interface DocumentRow extends Row {
  id: number;
  patient_id: number;
  appointment_id: number | null;
  plan_id: number | null;
  template_id: number | null;
  type: DocumentType;
  title: string;
  body: string;
  status: 'rascunho' | 'emitido' | 'cancelado';
  version: number;
  replaces_id: number | null;
  replaced_by_id: number | null;
  missing_variables_json: string | null;
  professional_id: number | null;
  professional_name_snapshot: string | null;
  professional_cro_snapshot: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: number | null;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Documento com o que a tela mostra (nome do paciente, do modelo e de quem criou). */
export interface DocumentDetailRow extends DocumentRow {
  patient_name: string;
  template_name: string | null;
  created_by_name: string | null;
  appointment_at: string | null;
  plan_title: string | null;
}

const DOCUMENTO_SELECT = `
  SELECT d.*, c.name AS patient_name, t.name AS template_name, u.username AS created_by_name,
         a.starts_at AS appointment_at, p.title AS plan_title
    FROM odonto_documents d
    JOIN odonto_patients pa ON pa.id = d.patient_id
    JOIN customers c ON c.id = pa.customer_id
    LEFT JOIN odonto_document_templates t ON t.id = d.template_id
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN odonto_appointments a ON a.id = d.appointment_id
    LEFT JOIN odonto_treatment_plans p ON p.id = d.plan_id`;

class DocumentRepository extends BaseRepository<DocumentTemplateRow> {
  constructor() {
    super('odonto_document_templates');
  }

  // ───────────────────────────── Modelos (PR §15) ─────────────────────────────

  listTemplates(opts: { type?: string; activeOnly?: boolean } = {}): DocumentTemplateRow[] {
    const filtros = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.type) { filtros.push('type = ?'); params.push(opts.type); }
    if (opts.activeOnly !== false) filtros.push('active = 1');
    return this.raw(
      `SELECT * FROM odonto_document_templates WHERE ${filtros.join(' AND ')}
        ORDER BY sort_order, name`,
      ...(params as never[]),
    ) as unknown as DocumentTemplateRow[];
  }

  findTemplate(id: number): DocumentTemplateRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_document_templates WHERE id = ? AND deleted_at IS NULL',
      id,
    ) as unknown as DocumentTemplateRow | undefined;
  }

  findTemplateByCode(code: string): DocumentTemplateRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_document_templates WHERE code = ? AND deleted_at IS NULL',
      code,
    ) as unknown as DocumentTemplateRow | undefined;
  }

  createTemplate(data: Record<string, unknown>): number {
    const campos = [
      'code', 'name', 'type', 'body', 'variables_json', 'requires_professional',
      'active', 'sort_order', 'is_system',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_document_templates (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  updateTemplate(id: number, patch: Record<string, unknown>): void {
    const campos = [
      'name', 'type', 'body', 'variables_json', 'requires_professional', 'active', 'sort_order',
    ].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_document_templates SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  softDeleteTemplate(id: number): void {
    this.rawRun(
      `UPDATE odonto_document_templates SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  /** Quantos documentos saíram deste modelo (modelo em uso não é apagado, é desativado). */
  templateUsage(templateId: number): number {
    const row = this.rawOne(
      'SELECT COUNT(*) AS t FROM odonto_documents WHERE template_id = ?',
      templateId,
    ) as { t: number } | undefined;
    return Number(row?.t ?? 0);
  }

  // ───────────────────────────── Documentos (PR §14) ─────────────────────────────

  listByPatient(patientId: number, opts: { type?: string } = {}): DocumentDetailRow[] {
    const params: unknown[] = [patientId];
    let filtroTipo = '';
    if (opts.type) { filtroTipo = ' AND d.type = ?'; params.push(opts.type); }
    return this.raw(
      `${DOCUMENTO_SELECT}
        WHERE d.patient_id = ? AND d.deleted_at IS NULL${filtroTipo}
        ORDER BY d.created_at DESC, d.id DESC`,
      ...(params as never[]),
    ) as unknown as DocumentDetailRow[];
  }

  findDocument(id: number): DocumentDetailRow | undefined {
    return this.rawOne(
      `${DOCUMENTO_SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`,
      id,
    ) as unknown as DocumentDetailRow | undefined;
  }

  /** Cadeia de revisões: o documento e todas as versões ligadas a ele (antes e depois). */
  revisionChain(id: number): DocumentDetailRow[] {
    const cadeia = this.raw(
      `WITH RECURSIVE cadeia(id) AS (
         SELECT id FROM odonto_documents WHERE id = ?
         UNION
         SELECT d.id FROM odonto_documents d JOIN cadeia c
           ON d.replaces_id = c.id OR d.id = (SELECT replaces_id FROM odonto_documents WHERE id = c.id)
       )
       SELECT d.* FROM odonto_documents d JOIN cadeia c ON c.id = d.id WHERE d.deleted_at IS NULL`,
      id,
    ) as unknown as DocumentRow[];
    // Reaproveita o SELECT completo (nome do paciente etc.) para cada item da cadeia.
    return cadeia
      .map((d) => this.findDocument(d.id))
      .filter((d): d is DocumentDetailRow => !!d)
      .sort((a, b) => a.version - b.version);
  }

  createDocument(data: Record<string, unknown>): number {
    const campos = [
      'patient_id', 'appointment_id', 'plan_id', 'template_id', 'type', 'title', 'body', 'status',
      'version', 'replaces_id', 'missing_variables_json', 'professional_id',
      'professional_name_snapshot', 'professional_cro_snapshot', 'created_by',
    ].filter((f) => data[f] !== undefined);
    return Number(this.rawRun(
      `INSERT INTO odonto_documents (${campos.join(', ')}, uuid)
       VALUES (${campos.map(() => '?').join(', ')}, ?)`,
      ...campos.map((f) => data[f] as never), randomUUID(),
    ).lastInsertRowid);
  }

  updateDocument(id: number, patch: Record<string, unknown>): void {
    const campos = [
      'title', 'body', 'status', 'type', 'professional_id', 'professional_name_snapshot',
      'professional_cro_snapshot', 'missing_variables_json', 'issued_at', 'cancelled_at',
      'cancel_reason', 'replaced_by_id', 'appointment_id', 'plan_id',
    ].filter((f) => patch[f] !== undefined);
    if (!campos.length) return;
    this.rawRun(
      `UPDATE odonto_documents SET ${campos.map((f) => `${f} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ?`,
      ...campos.map((f) => patch[f] as never), id,
    );
  }

  softDeleteDocument(id: number): void {
    this.rawRun(
      `UPDATE odonto_documents SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
  }

  /** Excluir o paciente leva os documentos junto (o chamador já garante a transação). */
  softDeleteByPatient(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_documents SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }

  /** Resumo para a ficha do paciente e para o painel. */
  resumo(patientId: number): { total: number; emitidos: number; rascunhos: number; ultimo_em: string | null } {
    const row = this.rawOne(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'emitido' THEN 1 ELSE 0 END) AS emitidos,
              SUM(CASE WHEN status = 'rascunho' THEN 1 ELSE 0 END) AS rascunhos,
              MAX(CASE WHEN status = 'emitido' THEN issued_at END) AS ultimo_em
         FROM odonto_documents WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    ) as { total: number | null; emitidos: number | null; rascunhos: number | null; ultimo_em: string | null } | undefined;
    return {
      total: Number(row?.total ?? 0),
      emitidos: Number(row?.emitidos ?? 0),
      rascunhos: Number(row?.rascunhos ?? 0),
      ultimo_em: row?.ultimo_em ?? null,
    };
  }

  /** Contagem por tipo num período (relatórios da fase 9). */
  countByType(from: string, to: string): { type: DocumentType; total: number; emitidos: number }[] {
    return this.raw(
      `SELECT type, COUNT(*) AS total,
              SUM(CASE WHEN status = 'emitido' THEN 1 ELSE 0 END) AS emitidos
         FROM odonto_documents
        WHERE deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?
        GROUP BY type ORDER BY total DESC`,
      from, to,
    ) as unknown as { type: DocumentType; total: number; emitidos: number }[];
  }

  /** Documentos emitidos num período (painel: "documentos emitidos no mês"). */
  emitidosEntre(from: string, to: string): number {
    const row = this.rawOne(
      `SELECT COUNT(*) AS t FROM odonto_documents
        WHERE deleted_at IS NULL AND status = 'emitido' AND date(issued_at) BETWEEN ? AND ?`,
      from, to,
    ) as { t: number } | undefined;
    return Number(row?.t ?? 0);
  }
}

export const documentRepository = new DocumentRepository();
