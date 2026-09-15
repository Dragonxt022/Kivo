/**
 * Data/hora no painel (lado navegador) — espelho de `src/format.ts` do cloud.
 *
 * As telas recebem do MySQL o valor cru (`YYYY-MM-DD HH:MM:SS.000`) e mostravam isso
 * direto. Aqui viram o formato brasileiro (DD/MM/AAAA HH:MM), igual ao lado servidor.
 */
(function () {
  function fmtDate(v) {
    var s = String(v == null ? '' : v).slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '—';
  }
  function fmtDateTime(v) {
    var s = String(v == null ? '' : v);
    var dia = fmtDate(s);
    if (dia === '—') return '—';
    var hm = s.slice(11, 16);
    return /^\d{2}:\d{2}$/.test(hm) ? dia + ' ' + hm : dia;
  }
  window.fmtDate = fmtDate;
  window.fmtDateTime = fmtDateTime;
})();
