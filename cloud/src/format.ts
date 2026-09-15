/**
 * Formatação de data/hora do painel (lado servidor).
 *
 * O MySQL devolve `YYYY-MM-DD HH:MM:SS[.sss]` cru, e as telas mostravam isso direto
 * ("2026-09-15 13:00:53.000"). Aqui viram o formato brasileiro (DD/MM/AAAA HH:MM).
 *
 * Espelhado em `public/js/dates.js` para as telas que formatam no navegador (Alpine) —
 * são deployables sem pacote compartilhado, mesma razão do espelho em `plans.ts`.
 */

/** `YYYY-MM-DD...` → `DD/MM/AAAA`; vazio/inválido → `—`. */
export function fmtDateBr(v: unknown): string {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/** `YYYY-MM-DD HH:MM:SS...` → `DD/MM/AAAA HH:MM`; sem hora válida, só a data. */
export function fmtDateTimeBr(v: unknown): string {
  const s = String(v ?? '');
  const dia = fmtDateBr(s);
  if (dia === '—') return '—';
  const hm = s.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(hm) ? `${dia} ${hm}` : dia;
}
