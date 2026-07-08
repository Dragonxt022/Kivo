/**
 * Datas/horas no banco são sempre UTC (datetime('now') do SQLite) — necessário pra
 * sincronização entre máquinas em fusos diferentes. Aqui só a EXIBIÇÃO converte pro
 * fuso da loja (Porto Velho/Amazonas, sem horário de verão desde 2019).
 */
const KATSU_TIMEZONE = 'America/Porto_Velho';

/** Timestamp completo (created_at, opened_at, paid_at...) — é um instante, precisa converter fuso. */
function fmtDateTime(raw) {
  if (!raw) return '—';
  const d = new Date(String(raw).replace(' ', 'T').replace(/(\.\d+)?$/, '') + 'Z');
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleString('pt-BR', {
    timeZone: KATSU_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}

/** Data pura (due_date, valid_until...) — calendário, não é um instante: nunca converte fuso. */
function fmtDate(raw) {
  if (!raw) return '—';
  const s = String(raw).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** "Hoje" no fuso da loja, formato YYYY-MM-DD — para filtros de dia (ex.: relatório de vendas). */
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KATSU_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
