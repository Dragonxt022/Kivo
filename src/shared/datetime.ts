/**
 * Fuso horário do sistema: o da MÁQUINA de quem está usando (Windows/navegador), em vez de
 * um fixo. Como o Kivo roda no computador da loja, o fuso do SO é exatamente o do usuário.
 *
 * O banco guarda tudo em UTC (`datetime('now')`) para sincronizar entre máquinas; o fuso só
 * entra na EXIBIÇÃO e no agrupamento por dia ("hoje" = dia local). Espelhado em
 * `public/js/datetime.js` para o lado do navegador.
 */

/** Fuso IANA da máquina (ex.: 'America/Manaus'). Fallback fixo se o ambiente não expõe Intl. */
export function appTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // ambiente sem Intl: cai no fallback
  }
  return 'America/Porto_Velho';
}

/** Data (no fuso da máquina) no formato YYYY-MM-DD. */
export function localIso(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Data de HOJE no fuso da máquina, no formato YYYY-MM-DD (para filtros de dia). */
export function todayLocalIso(): string {
  return localIso();
}
