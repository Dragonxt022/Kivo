import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import {
  procedureRepository,
  type ProcedureRow,
} from './repositories/ProcedureRepository';

/**
 * Catálogo de procedimentos odontológicos (PR §13).
 *
 * O procedimento é clínico; quando ele também é vendido/estocado, `product_id` aponta para o
 * produto/serviço que já existe no commercial — assim preço e estoque não têm duas verdades.
 */

export interface ProcedureInput {
  name?: string;
  product_id?: number | null;
  code?: string | null;
  category?: string | null;
  description?: string | null;
  default_price_cents?: number;
  duration_min?: number | null;
  active?: boolean | number;
}

export type ProcedureResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function listProcedures(opts: { q?: string; active?: boolean } = {}): ProcedureRow[] {
  return procedureRepository.list(opts);
}

export function getProcedure(id: number): ProcedureResult<ProcedureRow> {
  const row = procedureRepository.findById(id);
  if (!row) return { ok: false, error: 'Procedimento não encontrado.', status: 404 };
  return { ok: true, data: row };
}

function validate(input: ProcedureInput, id?: number): string | null {
  if (input.name !== undefined && !String(input.name).trim()) {
    return 'Campo obrigatório: name';
  }
  if (input.code) {
    const dupe = procedureRepository.findByCode(String(input.code).trim());
    if (dupe && dupe.id !== id) return `Já existe um procedimento com este código: ${dupe.name}.`;
  }
  if (input.default_price_cents !== undefined && input.default_price_cents < 0) {
    return 'Valor do procedimento não pode ser negativo.';
  }
  return null;
}

export function createProcedure(req: Request, input: ProcedureInput): ProcedureResult<{ id: number }> {
  assertAuth(req);
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, error: 'Campo obrigatório: name', status: 400 };
  const invalid = validate(input);
  if (invalid) return { ok: false, error: invalid, status: 400 };

  const id = procedureRepository.create({
    product_id: input.product_id ?? null,
    code: input.code ? String(input.code).trim() : null,
    name,
    category: input.category ?? null,
    description: input.description ?? null,
    default_price_cents: Math.round(input.default_price_cents ?? 0),
    duration_min: input.duration_min ?? null,
    active: input.active === undefined ? 1 : input.active ? 1 : 0,
    uuid: randomUUID(),
  });

  const created = procedureRepository.findById(id);
  audit(req, 'criar', 'odonto_procedure', id, null, created ?? null);
  return { ok: true, data: { id } };
}

export function updateProcedure(
  req: Request, id: number, input: ProcedureInput,
): ProcedureResult<ProcedureRow> {
  assertAuth(req);
  const before = procedureRepository.findById(id);
  if (!before) return { ok: false, error: 'Procedimento não encontrado.', status: 404 };
  const invalid = validate(input, id);
  if (invalid) return { ok: false, error: invalid, status: 400 };

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = String(input.name).trim();
  if (input.product_id !== undefined) data.product_id = input.product_id;
  if (input.code !== undefined) data.code = input.code ? String(input.code).trim() : null;
  if (input.category !== undefined) data.category = input.category;
  if (input.description !== undefined) data.description = input.description;
  if (input.default_price_cents !== undefined) data.default_price_cents = Math.round(input.default_price_cents);
  if (input.duration_min !== undefined) data.duration_min = input.duration_min;
  if (input.active !== undefined) data.active = input.active ? 1 : 0;

  if (Object.keys(data).length) procedureRepository.update(id, data);
  const after = procedureRepository.findById(id) as ProcedureRow;
  audit(req, 'editar', 'odonto_procedure', id, before, after);
  return { ok: true, data: after };
}

export function removeProcedure(req: Request, id: number): ProcedureResult<{ ok: true }> {
  assertAuth(req);
  const before = procedureRepository.findById(id);
  if (!before) return { ok: false, error: 'Procedimento não encontrado.', status: 404 };
  procedureRepository.softDelete(id);
  audit(req, 'excluir', 'odonto_procedure', id, before, null);
  return { ok: true, data: { ok: true } };
}
