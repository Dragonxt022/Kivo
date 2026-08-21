/** Página CRUD genérica (Alpine) usada pelas telas do commercial. */
function crudPage(apiBase) {
  return {
    rows: [], form: {}, q: '', error: '', dlgError: '',
    async load() {
      const r = await fetch(apiBase + (this.q ? `?q=${encodeURIComponent(this.q)}` : ''));
      if (r.ok) this.rows = await r.json();
      else this.error = (await r.json()).error ?? 'Erro ao carregar.';
    },
    openNew() { this.form = {}; this.dlgError = ''; this.$refs.dlg.showModal(); },
    openEdit(r) { this.form = { ...r }; this.dlgError = ''; this.$refs.dlg.showModal(); },
    async save() {
      const isEdit = !!this.form.id;
      const r = await fetch(isEdit ? `${apiBase}/${this.form.id}` : apiBase, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.form),
      });
      if (r.ok) { this.$refs.dlg.close(); this.load(); }
      else this.dlgError = (await r.json()).error ?? 'Erro ao salvar.';
    },
    async remove(row) {
      if (!await window.confirmDlg(`Excluir "${row.name}"?`)) return;
      const r = await fetch(`${apiBase}/${row.id}`, { method: 'DELETE' });
      if (r.ok) this.load(); else this.error = (await r.json()).error ?? 'Erro ao excluir.';
    },
  };
}

// API pública — usada como x-data="crudPage('/api/...')" nas views de CRUD simples.
window.crudPage = crudPage;
