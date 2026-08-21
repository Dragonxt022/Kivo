// Ícones e helpers de forma de pagamento, compartilhados entre o PDV e as telas
// de recebimento/pagamento de contas (financeiro, ficha do cliente).
function paymentMethodIcon(type) {
  const icons = {
    dinheiro: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>',
    debito: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    credito: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    pix: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="15" y="15" width="5" height="5" rx="1"/></svg>',
    prazo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  };
  return icons[type] ?? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
}

// Espalhar (...paymentMethodsMixin()) no x-data de telas que precisam listar formas
// de pagamento ativas com ícone — evita repetir o fetch e o mapa de ícones em cada tela.
function paymentMethodsMixin() {
  return {
    settleMethods: [],
    methodIcon: paymentMethodIcon,
    async loadPaymentMethods() {
      if (this.settleMethods.length) return;
      const r = await fetch('/api/finance/payment-methods/active');
      if (r.ok) this.settleMethods = await r.json();
    },
  };
}

// Espalhar (...cashRegisterInlineOpenMixin()) junto com a partial
// 'partials/cash-register-inline-open' para oferecer abrir o caixa sem perder
// o formulário em andamento, no mesmo padrão do PDV.
function cashRegisterInlineOpenMixin() {
  return {
    openRegisterForm: { opening: '', error: '' },
    openRegisterInline() {
      this.openRegisterForm = { opening: '', error: '' };
      this.$refs.openRegisterDlg.showModal();
      this.$nextTick(() => this.$refs.openRegisterInput?.focus());
    },
    async confirmOpenRegisterInline(onSuccess) {
      const r = await fetch('/api/finance/cash/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openingCents: this.cents(this.openRegisterForm.opening) }),
      });
      if (r.ok) {
        this.$refs.openRegisterDlg.close();
        if (onSuccess) onSuccess();
      } else {
        this.openRegisterForm.error = (await r.json()).error ?? 'Erro ao abrir o caixa.';
      }
    },
  };
}

// API pública — mixins usados nas views de caixa/PDV.
window.paymentMethodIcon = paymentMethodIcon;
window.paymentMethodsMixin = paymentMethodsMixin;
window.cashRegisterInlineOpenMixin = cashRegisterInlineOpenMixin;
