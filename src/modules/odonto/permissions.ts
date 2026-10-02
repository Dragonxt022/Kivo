import type { Request } from 'express';

/**
 * Permissões e resultado padrão do módulo odonto.
 *
 * Ficam aqui (e não em `patients.ts`) porque módulo clínico é uma teia: a anamnese precisa
 * das mesmas permissões do paciente, e o paciente precisa apagar a anamnese dele. Com as
 * permissões no meio, os dois se importam sem ciclo.
 */

export const PERM_CLINICAL_VIEW = 'odonto.clinical.view';
export const PERM_CLINICAL_EDIT = 'odonto.clinical.edit';

/** Resultado das regras do módulo: erro já com o status HTTP decidido. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function canViewClinical(req: Request): boolean {
  return !!req.user?.permissions.has(PERM_CLINICAL_VIEW);
}

export function canEditClinical(req: Request): boolean {
  return !!req.user?.permissions.has(PERM_CLINICAL_EDIT);
}
