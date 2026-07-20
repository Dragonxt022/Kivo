/**
 * Datas/horas no banco são sempre UTC (datetime('now') do SQLite) — necessário pra
 * sincronização entre máquinas em fusos diferentes. Aqui só a EXIBIÇÃO converte pro
 * fuso da loja (Porto Velho/Amazonas, sem horário de verão desde 2019).
 */
const KIVO_TIMEZONE = 'America/Porto_Velho';

/** Timestamp completo (created_at, opened_at, paid_at...) — é um instante, precisa converter fuso. */
function fmtDateTime(raw) {
  if (!raw) return '—';
  const d = new Date(String(raw).replace(' ', 'T').replace(/(\.\d+)?$/, '') + 'Z');
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleString('pt-BR', {
    timeZone: KIVO_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
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
  return new Intl.DateTimeFormat('en-CA', { timeZone: KIVO_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * Navegador de mês reutilizável — inclua com x-data="monthNav()" e ouça
 * @month-change.window para reagir (ex.: @month-change.window="month = $event.detail.key; load()")
 */
function monthNav(initial) {
  const d = initial ? new Date(initial + '-01') : new Date();
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    get label() {
      return new Date(this.year, this.month)
        .toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })
        .replace('.', '');
    },
    get key() { return `${this.year}-${String(this.month + 1).padStart(2, '0')}`; },
    prev() { if (this.month === 0) { this.month = 11; this.year--; } else this.month--; },
    next() { if (this.month === 11) { this.month = 0; this.year++; } else this.month++; },
  };
}
