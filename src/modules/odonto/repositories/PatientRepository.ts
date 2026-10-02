import { BaseRepository, type Row } from '../../../core/database/repository';
import { stableUuid } from '../../../shared/uuid';

/** Linha crua de `odonto_patients` (ficha do paciente, sem os dados do cliente). */
export interface PatientRow extends Row {
  id: number;
  customer_id: number;
  sex: string | null;
  rg: string | null;
  photo_file: string | null;
  notes: string | null;
  active: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  comment: string;
}

/** Paciente já com o cadastro do cliente (`customers`) para a listagem e a ficha. */
export interface PatientListRow extends Row {
  id: number;
  customer_id: number;
  name: string;
  document: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  cep: string | null;
  /** Data de nascimento — vive em `customers.birthday`, não é duplicada no módulo. */
  birthday: string | null;
  sex: string | null;
  rg: string | null;
  notes: string | null;
  active: number;
  updated_at: string;
  /** 1 quando já existe ficha clínica gravada (a lista não expõe o conteúdo clínico). */
  has_clinical: number;
}

export interface PatientClinicalRow extends Row {
  id: number;
  patient_id: number;
  medical_history: string | null;
  dental_history: string | null;
  allergies: string | null;
  medications: string | null;
  conditions: string | null;
  clinical_notes: string | null;
  updated_by: number | null;
  updated_at: string;
}

export interface PatientClinicalInput {
  medical_history?: string | null;
  dental_history?: string | null;
  allergies?: string | null;
  medications?: string | null;
  conditions?: string | null;
  clinical_notes?: string | null;
}

/** Colunas de cadastro do paciente que o módulo aceita gravar. */
export const PATIENT_FIELDS = ['sex', 'rg', 'photo_file', 'notes', 'active'] as const;

/** Colunas da ficha clínica (dado sensível) — sempre atrás da permissão clínica. */
const CLINICAL_FIELDS = [
  'medical_history', 'dental_history', 'allergies', 'medications', 'conditions', 'clinical_notes',
] as const;

class PatientRepository extends BaseRepository<PatientRow> {
  constructor() {
    super('odonto_patients');
  }

  /**
   * Lista para a tela: paciente + dados cadastrais do cliente (nome, documento, contato) e um
   * sinalizador de ficha clínica. O CONTEÚDO clínico não entra aqui — quem não tem permissão
   * clínica recebe a lista do mesmo jeito, sem o dado sensível.
   */
  list(opts: { q?: string; active?: boolean } = {}): PatientListRow[] {
    const where: string[] = ['p.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.active !== undefined) {
      where.push('p.active = ?');
      params.push(opts.active ? 1 : 0);
    }
    const q = (opts.q ?? '').trim();
    if (q) {
      where.push('(c.name LIKE ? OR c.document LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    return this.raw(
      `SELECT p.id, p.customer_id, c.name, c.document, c.phone, c.email, c.address, c.cep,
              c.birthday, p.sex, p.rg, p.notes, p.active, p.updated_at,
              EXISTS(
                SELECT 1 FROM odonto_patient_clinical cc
                 WHERE cc.patient_id = p.id AND cc.deleted_at IS NULL
              ) AS has_clinical
         FROM odonto_patients p
         JOIN customers c ON c.id = p.customer_id AND c.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        ORDER BY c.name`,
      ...params,
      // A projeção acima É o contrato de PatientListRow (join com customers).
    ) as unknown as PatientListRow[];
  }

  /** Mesma projeção da lista, para um paciente só (usada na ficha). */
  findDetail(id: number): PatientListRow | undefined {
    return this.rawOne(
      `SELECT p.id, p.customer_id, c.name, c.document, c.phone, c.email, c.address, c.cep,
              c.birthday, p.sex, p.rg, p.notes, p.active, p.updated_at,
              EXISTS(
                SELECT 1 FROM odonto_patient_clinical cc
                 WHERE cc.patient_id = p.id AND cc.deleted_at IS NULL
              ) AS has_clinical
         FROM odonto_patients p
         JOIN customers c ON c.id = p.customer_id AND c.deleted_at IS NULL
        WHERE p.id = ? AND p.deleted_at IS NULL`,
      id,
    ) as unknown as PatientListRow | undefined;
  }

  /** Paciente ativo de um cliente — a regra "um paciente por cliente" é de aplicação. */
  findByCustomer(customerId: number): PatientRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_patients WHERE customer_id = ? AND deleted_at IS NULL LIMIT 1',
      customerId,
    );
  }

  getClinical(patientId: number): PatientClinicalRow | undefined {
    return this.rawOne(
      'SELECT * FROM odonto_patient_clinical WHERE patient_id = ? AND deleted_at IS NULL',
      patientId,
    ) as unknown as PatientClinicalRow | undefined;
  }

  /**
   * Grava (ou atualiza) a ficha clínica. `ON CONFLICT(patient_id)` mantém uma linha por
   * paciente — a versão de prontuário com histórico (retificação) é da Fase 4, não desta.
   */
  upsertClinical(patientId: number, data: PatientClinicalInput, userId: number | null): void {
    const values = CLINICAL_FIELDS.map((f) => data[f] ?? null);
    this.rawRun(
      `INSERT INTO odonto_patient_clinical
         (patient_id, ${CLINICAL_FIELDS.join(', ')}, updated_by, uuid)
       VALUES (?, ${CLINICAL_FIELDS.map(() => '?').join(', ')}, ?, ?)
       ON CONFLICT(patient_id) DO UPDATE SET
         ${CLINICAL_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
         updated_by = excluded.updated_by,
         deleted_at = NULL,
         updated_at = datetime('now')`,
      patientId, ...values, userId, stableUuid(`odonto_patient_clinical:${patientId}`),
    );
  }

  softDeleteClinical(patientId: number): void {
    this.rawRun(
      `UPDATE odonto_patient_clinical
          SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE patient_id = ? AND deleted_at IS NULL`,
      patientId,
    );
  }
}

export const patientRepository = new PatientRepository();
