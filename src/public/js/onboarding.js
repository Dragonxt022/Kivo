function onboardingWizard() {
  return {
    open: false,
    mode: 'first-run', // 'first-run' | 'reopen'
    step: 0,
    totalSteps: 6,
    answers: { usage: null, businessType: null, activePaymentMethodIds: [] },
    paymentMethods: [],
    loading: false,
    error: '',
    result: null,

    async checkFirstRun() {
      try {
        const r = await fetch('/api/onboarding/status');
        if (r.ok) {
          const status = await r.json();
          if (!status.completed) await this.openFirstRun();
        }
      } catch (e) {
        // sem conexão — não trava a home, só não mostra o wizard agora
      }
    },
    async openFirstRun() {
      this.mode = 'first-run';
      await this.resetAndLoad();
    },
    async openReopen() {
      this.mode = 'reopen';
      await this.resetAndLoad();
    },
    async resetAndLoad() {
      this.step = 0;
      this.error = '';
      this.result = null;
      this.answers = { usage: null, businessType: null, activePaymentMethodIds: [] };
      this.open = true;
      this.$nextTick(() => {
        this.$refs.onboardingDlg?.showModal();
        // sem isso, o navegador foca o 1o botão focável do DOM (que pode estar num passo
        // seguinte, ainda fora de tela) e rola o .wizard-viewport pra revelar ele,
        // desalinhando o slider — o dialog fica com o foco (tabindex="-1") em vez disso.
        this.$refs.onboardingDlg?.focus();
        this.resetScroll();
      });
      try {
        const r = await fetch('/api/onboarding/payment-methods');
        if (r.ok) {
          this.paymentMethods = await r.json();
          this.answers.activePaymentMethodIds = this.paymentMethods.filter((p) => p.active).map((p) => p.id);
        }
      } catch (e) {
        // segue sem a lista — o passo de pagamento só fica vazio
      }
    },
    close() {
      this.open = false;
      this.$refs.onboardingDlg?.close();
    },

    resetScroll() {
      const vp = this.$refs.onboardingDlg?.querySelector('.wizard-viewport');
      if (vp) vp.scrollLeft = 0;
    },
    next() { if (this.step < this.totalSteps - 1) { this.step++; this.$nextTick(() => this.resetScroll()); } },
    back() { if (this.step > 0) { this.step--; this.$nextTick(() => this.resetScroll()); } },

    chooseUsage(v) {
      this.answers.usage = v;
      setTimeout(() => this.next(), 260);
    },
    chooseBusiness(v) {
      this.answers.businessType = v;
      setTimeout(() => this.next(), 260);
    },
    togglePayment(id) {
      const idx = this.answers.activePaymentMethodIds.indexOf(id);
      if (idx === -1) this.answers.activePaymentMethodIds.push(id);
      else this.answers.activePaymentMethodIds.splice(idx, 1);
    },

    willCreateTables() {
      return (this.answers.usage === 'mesas' || this.answers.usage === 'ambos') && this.answers.businessType !== 'roupas';
    },

    async skipWizard() {
      await fetch('/api/onboarding/skip', { method: 'POST' });
      this.close();
    },

    async finish(createDemoData, resetDemoData = false) {
      if (!this.answers.usage || !this.answers.businessType) {
        this.error = 'Volte e responda as perguntas anteriores.';
        return;
      }
      this.loading = true;
      this.error = '';
      try {
        const r = await fetch('/api/onboarding/provision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usage: this.answers.usage,
            businessType: this.answers.businessType,
            activePaymentMethodIds: this.answers.activePaymentMethodIds,
            createDemoData,
            resetDemoData,
          }),
        });
        if (!r.ok) {
          this.error = (await r.json()).error ?? 'Erro ao configurar o ambiente.';
          return;
        }
        this.result = await r.json();
        this.step = this.totalSteps - 1;
        this.$nextTick(() => this.resetScroll());
      } catch (e) {
        this.error = 'Erro de conexão.';
      } finally {
        this.loading = false;
      }
    },

    successMessage() {
      if (!this.result) return 'Suas preferências foram salvas.';
      const parts = [];
      if (this.result.tablesCreated) parts.push(`${this.result.tablesCreated} mesas`);
      if (this.result.productsCreated) parts.push(`${this.result.productsCreated} produtos de exemplo`);
      const criado = parts.length ? `Criamos ${parts.join(' e ')}. ` : '';
      const pagamentos = this.result.paymentMethodsActive?.length
        ? `Formas de pagamento ativas: ${this.result.paymentMethodsActive.join(', ')}.`
        : '';
      return `${criado}${pagamentos} Já é só usar.`;
    },
  };
}
