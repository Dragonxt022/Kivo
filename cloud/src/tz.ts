/**
 * Fuso horário do Kivo Web: o do DISPOSITIVO de quem está usando, enviado no cookie
 * `kivo_tz` (o painel móvel grava esse cookie a partir do navegador). O servidor da nuvem
 * não tem como saber onde o lojista está, então sem o cookie cai no fallback.
 */

/** Fuso IANA do dispositivo (cookie `kivo_tz`), ou o fallback de Porto Velho. */
export function clientTimezone(req: { headers: { cookie?: string } }): string {
  const m = /(?:^|;\s*)kivo_tz=([^;]+)/.exec(req.headers.cookie ?? '');
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      // cookie ilegível: usa o fallback
    }
  }
  return 'America/Porto_Velho';
}

/** Data YYYY-MM-DD no fuso informado, deslocada por N dias (padrão: hoje). */
export function dateInTz(tz: string, offsetDays = 0): string {
  const at = Date.now() + offsetDays * 86400e3;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}
