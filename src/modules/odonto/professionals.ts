import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { userRepository } from '../../core/repositories/UserRepository';
import {
  professionalRepository,
  type ProfessionalRow,
} from './repositories/ProfessionalRepository';

/**
 * Profissionais que atendem no consultório (PR §24.5).
 *
 * O CRO vive aqui, não em `users`: nem todo profissional tem login no Kivo (auxiliar,
 * técnico) e nem todo usuário atende (recepção, administrador). `user_id` é o vínculo
 * opcional quando o profissional também opera o sistema.
 */

export interface ProfessionalInput {
  name?: string;
  user_id?: number | null;
  cro?: string | null;
  cro_state?: string | null;
  specialties?: string | null;
  phone?: string | null;
  email?: string | null;
  active?: boolean | number;
}

export type ProfessionalResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function listProfessionals(opts: { q?: string; active?: boolean } = {}): ProfessionalRow[] {
  return professionalRepository.list(opts);
}

export function getProfessional(id: number): ProfessionalResult<ProfessionalRow> {
  const row = professionalRepository.findById(id);
  if (!row) return { ok: false, error: 'Profissional não encontrado.', status: 404 };
  return { ok: true, data: row };
}

function validate(input: ProfessionalInput, id?: number): string | null {
  if (input.name !== undefined && !String(input.name).trim()) {
    return 'Campo obrigatório: name';
  }
  if (input.user_id != null && !userRepository.findById(Number(input.user_id))) {
    return 'Usuário não encontrado para vincular ao profissional.';
  }
  if (input.cro) {
    const cro = String(input.cro).trim();
    const extra = id ? ' AND id != ?' : '';
    const params: unknown[] = [cro, input.cro_state ?? null];
    if (id) params.push(id);
    const dupe = professionalRepository.rawOne(
      `SELECT id, name FROM odonto_professionals
        WHERE deleted_at IS NULL AND cro = ?
          AND COALESCE(cro_state, '') = COALESCE(?, '')${extra}
        LIMIT 1`,
      ...params,
    ) as { id: number; name: string } | undefined;
    if (dupe) return `Já existe um profissional com este CRO: ${dupe.name}.`;
  }
  return null;
}

export function createProfessional(req: Request, input: ProfessionalInput): ProfessionalResult<{ id: number }> {
  assertAuth(req);
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, error: 'Campo obrigatório: name', status: 400 };
  const invalid = validate(input);
  if (invalid) return { ok: false, error: invalid, status: 400 };

  const id = professionalRepository.create({
    user_id: input.user_id ?? null,
    name,
    cro: input.cro ?? null,
    cro_state: input.cro_state ? String(input.cro_state).toUpperCase().slice(0, 2) : null,
    specialties: input.specialties ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    active: input.active === undefined ? 1 : input.active ? 1 : 0,
    uuid: randomUUID(),
  });

  const created = professionalRepository.findById(id);
  audit(req, 'criar', 'odonto_professional', id, null, created ?? null);
  return { ok: true, data: { id } };
}

export function updateProfessional(
  req: Request, id: number, input: ProfessionalInput,
): ProfessionalResult<ProfessionalRow> {
  assertAuth(req);
  const before = professionalRepository.findById(id);
  if (!before) return { ok: false, error: 'Profissional não encontrado.', status: 404 };
  const invalid = validate(input, id);
  if (invalid) return { ok: false, error: invalid, status: 400 };

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = String(input.name).trim();
  if (input.user_id !== undefined) data.user_id = input.user_id;
  if (input.cro !== undefined) data.cro = input.cro;
  if (input.cro_state !== undefined) {
    data.cro_state = input.cro_state ? String(input.cro_state).toUpperCase().slice(0, 2) : null;
  }
  if (input.specialties !== undefined) data.specialties = input.specialties;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email;
  if (input.active !== undefined) data.active = input.active ? 1 : 0;

  if (Object.keys(data).length) professionalRepository.update(id, data);
  const after = professionalRepository.findById(id) as ProfessionalRow;
  audit(req, 'editar', 'odonto_professional', id, before, after);
  return { ok: true, data: after };
}

export function removeProfessional(req: Request, id: number): ProfessionalResult<{ ok: true }> {
  assertAuth(req);
  const before = professionalRepository.findById(id);
  if (!before) return { ok: false, error: 'Profissional não encontrado.', status: 404 };
  professionalRepository.softDelete(id);
  audit(req, 'excluir', 'odonto_professional', id, before, null);
  return { ok: true, data: { ok: true } };
}

/** Contrato exposto a outros módulos (a agenda vai escolher o profissional). */
export interface OdontoProfessionalsService {
  findById(id: number): ProfessionalRow | undefined;
  listActive(): ProfessionalRow[];
  search(term: string, limit?: number): ProfessionalRow[];
}

export const odontoProfessionalsService: OdontoProfessionalsService = {
  findById: (id) => professionalRepository.findById(id),
  listActive: () => professionalRepository.list({ active: true }),
  search: (term, limit) => professionalRepository.search(term, limit),
};
