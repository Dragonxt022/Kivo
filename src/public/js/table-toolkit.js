/**
 * Mixin Alpine compartilhado pelas telas de listagem padronizadas: ordenação de
 * cabeçalho em 3 estados (asc → desc → sem ordenação) e seleção múltipla + exclusão
 * em massa. Uso: `x-data="{ ...tableToolkit(), rows: [], ... }"`.
 *
 * A ordenação é não-destrutiva por design: quando `sortBy` volta a `null`,
 * `sortedRows()` devolve as linhas na ordem em que chegaram (a ordem que o servidor
 * mandou), sem reaplicar nenhum sort por cima — é o que permite favoritos (ou
 * qualquer outra ordenação vinda do backend) aparecerem corretamente quando não há
 * coluna ativa, e "desligar" de vez um sort de coluna com um terceiro clique.
 */
function tableToolkit() {
  return {
    sortBy: null,
    sortDir: null,
    selectedIds: [],
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

    isSelected(id) { return this.selectedIds.includes(id); },
    toggleSelect(id) {
      const i = this.selectedIds.indexOf(id);
      if (i === -1) this.selectedIds.push(id);
      else this.selectedIds.splice(i, 1);
    },
    isAllSelected(rows) { return rows.length > 0 && rows.every((r) => this.selectedIds.includes(r.id)); },
    toggleSelectAll(rows) {
      this.selectedIds = this.isAllSelected(rows) ? [] : rows.map((r) => r.id);
    },
    clearSelection() { this.selectedIds = []; },
    /** Chamar ao fim de todo load(): tira da seleção ids que já não estão mais na lista atual. */
    pruneSelection(rows) {
      const ids = new Set(rows.map((r) => r.id));
      this.selectedIds = this.selectedIds.filter((id) => ids.has(id));
    },

    /** opts: { label, confirmMessage, onDone(data), onError(message) } */
    async bulkDelete(apiBase, opts) {
      opts = opts || {};
      if (!this.selectedIds.length) return;
      const label = opts.label || 'registro(s)';
      const confirmMessage = opts.confirmMessage
        || `Excluir ${this.selectedIds.length} ${label} selecionado(s)? Essa ação não pode ser desfeita.`;
      if (!(await window.confirmDlg(confirmMessage))) return;
      const r = await fetch(`${apiBase}/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: this.selectedIds }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (opts.onError) opts.onError(data.error ?? 'Erro ao excluir selecionados.');
        return;
      }
      this.clearSelection();
      if (opts.onDone) opts.onDone(data);
    },
  };
}
