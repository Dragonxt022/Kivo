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

    sortCycle(col) {
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
  };
}
