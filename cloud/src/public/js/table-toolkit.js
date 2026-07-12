/**
 * Mixin Alpine compartilhado pelas telas de listagem do painel: ordenação de
 * cabeçalho em 3 estados (asc → desc → sem ordenação) + estado do menu de ações "⋮".
 * Uso: `x-data="{ ...tableToolkit(), rows: [...] }"`.
 *
 * A ordenação é não-destrutiva por design: quando `sortBy` volta a `null`,
 * `sortedRows()` devolve as linhas na ordem em que chegaram (a ordem que o servidor
 * mandou), sem reaplicar nenhum sort por cima — um terceiro clique no mesmo
 * cabeçalho "desliga" a ordenação de vez.
 */
function tableToolkit() {
  return {
    sortBy: null,
    sortDir: null,
    openMenu: null,
    page: 1,
    pageSize: 20,

    sortCycle(col) {
      this.page = 1;
      if (this.sortBy !== col) {
        this.sortBy = col;
        this.sortDir = 'asc';
      } else if (this.sortDir === 'asc') {
        this.sortDir = 'desc';
      } else {
        this.sortBy = null;
        this.sortDir = null;
      }
    },
    sortArrow(col) {
      return this.sortBy === col ? (this.sortDir === 'asc' ? '▲' : '▼') : '';
    },
    /** `getters` é um mapa { coluna: (row) => valor comparável }, definido por página. */
    sortedRows(rows, getters) {
      if (!this.sortBy || !getters || !getters[this.sortBy]) return rows;
      const getter = getters[this.sortBy];
      const dir = this.sortDir === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        const va = getter(a);
        const vb = getter(b);
        if (typeof va === 'string' || typeof vb === 'string') {
          return dir * String(va ?? '').toLowerCase().localeCompare(String(vb ?? '').toLowerCase());
        }
        return dir * ((va ?? 0) - (vb ?? 0));
      });
    },

    /** Paginação client-side. Chame sempre APÓS sortedRows/filterRows. */
    pageCount(total) { return Math.max(1, Math.ceil(total / this.pageSize)); },
    pagedRows(rows) {
      const count = this.pageCount(rows.length);
      if (this.page > count) this.page = count;
      const start = (this.page - 1) * this.pageSize;
      return rows.slice(start, start + this.pageSize);
    },
    goToPage(n, total) {
      this.page = Math.min(Math.max(1, n), this.pageCount(total));
    },
    /** Janela de páginas pro paginador — nunca lista todas quando há muitas. */
    pageWindow(total) {
      const count = this.pageCount(total);
      const cur = Math.min(this.page, count);
      const keep = new Set([1, count, cur - 1, cur, cur + 1]);
      const out = [];
      let prev = 0;
      for (let i = 1; i <= count; i++) {
        if (!keep.has(i)) continue;
        if (prev && i - prev > 1) out.push('…');
        out.push(i);
        prev = i;
      }
      return out;
    },
  };
}
