function onboardingWizard() {
  return {
    open: false,
    mode: 'first-run', // 'first-run' | 'reopen'
    step: 0,
    totalSteps: 8,
    answers: { usage: null, businessType: null, activePaymentMethodIds: [] },
    // Preferências de interface/cor (localStorage, per-máquina) — nunca vão em `answers`
    // nem no POST de /api/onboarding/provision, que é só pra dados de negócio.
    uiInterface: (function(){ try { return localStorage.getItem('kivo-interface') || 'cards'; } catch(e){ return 'cards'; } })(),
    uiColorTheme: (function(){ try { return localStorage.getItem('kivo-color-theme') || 'orange'; } catch(e){ return 'orange'; } })(),
    uiCustomColor: (function(){ try { return localStorage.getItem('kivo-color-custom') || '#ff8000'; } catch(e){ return '#ff8000'; } })(),
    chooseInterface(v) {
      this.uiInterface = v;
      try { localStorage.setItem('kivo-interface', v); } catch (e) {}
    },
    chooseColorPreset(id) {
      this.uiColorTheme = id;
      var s = document.documentElement.style;
      s.removeProperty('--primary'); s.removeProperty('--icon-color');
      s.removeProperty('--primary-hover'); s.removeProperty('--primary-bg');
      document.documentElement.setAttribute('data-color-theme', id);
      try { localStorage.setItem('kivo-color-theme', id); } catch (e) {}
    },
    chooseCustomColor(hex) {
      this.uiCustomColor = hex; this.uiColorTheme = 'custom';
      document.documentElement.setAttribute('data-color-theme', 'custom');
      window.__kivoApplyCustomColor(hex);
      try { localStorage.setItem('kivo-color-theme', 'custom'); localStorage.setItem('kivo-color-custom', hex); } catch (e) {}
    },
    paymentMethods: [],
    // Recursos que o assistente liga/desliga. `features` é o catálogo vindo do servidor
    // (só o que existe e está no plano); `featureKeys` é o que ficará ligado no fim.
    features: [],
    featureKeys: [],
    // Enquanto for false, entrar no passo de recursos reaplica a recomendação — assim
    // voltar e trocar "balcão" por "mesas" atualiza a sugestão. Ao primeiro clique numa
    // chave o lojista assume o controle e a recomendação para de sobrescrever a escolha.
    featuresTouched: false,
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
      this.featureKeys = [];
      this.featuresTouched = false;
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
      try {
        const rf = await fetch('/api/onboarding/features');
        if (rf.ok) this.features = await rf.json();
      } catch (e) {
        // sem catálogo de recursos: o passo fica vazio e o provision cai na recomendação
        // do servidor, que é o mesmo que o assistente sugeriria aqui.
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
    next() {
      if (this.step >= this.totalSteps - 1) return;
      this.step++;
      if (this.step === this.STEP_FEATURES && !this.featuresTouched) this.applyRecommendedFeatures();
      this.$nextTick(() => this.resetScroll());
    },
    back() { if (this.step > 0) { this.step--; this.$nextTick(() => this.resetScroll()); } },

    // Passo dos recursos — nomeado porque `next()` e a view precisam dele e um número
    // solto aqui vira bug silencioso na próxima vez que um passo for inserido no meio.
    STEP_FEATURES: 4,

    /** Espelha isRecommended() de core/onboarding/service.ts — mesma regra, mesmo dado. */
    featureRecommended(f) {
      const r = f.recommend;
      if (!r || (!r.usage && !r.businessType)) return false;
      if (r.usage && r.usage.indexOf(this.answers.usage) === -1) return false;
      if (r.businessType && r.businessType.indexOf(this.answers.businessType) === -1) return false;
      return true;
    },
    applyRecommendedFeatures() {
      this.featureKeys = this.features.filter((f) => this.featureRecommended(f)).map((f) => f.key);
    },
    toggleFeature(key) {
      this.featuresTouched = true;
      const idx = this.featureKeys.indexOf(key);
      if (idx === -1) this.featureKeys.push(key);
      else this.featureKeys.splice(idx, 1);
    },
    selectedFeatureLabels() {
      return this.features.filter((f) => this.featureKeys.indexOf(f.key) !== -1).map((f) => f.label);
    },
    /** Recursos hoje ligados que o assistente vai DESLIGAR — o resumo avisa antes. */
    featuresToTurnOff() {
      return this.features.filter((f) => f.enabled && this.featureKeys.indexOf(f.key) === -1).map((f) => f.label);
    },

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

    // Espelha a condição do provision(): as mesas de exemplo acompanham o recurso de
    // mesas, não a resposta crua — desmarcar "Mesas e comandas" no passo anterior também
    // tira as 10 mesas do resumo.
    willCreateTables() {
      return this.featureKeys.indexOf('comandas.mesas') !== -1;
    },
    willCreateVariantProducts() {
      return this.answers.businessType === 'roupas' && this.featureKeys.indexOf('commercial.variantes') !== -1;
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
            activeFeatureKeys: this.featureKeys,
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
      const ligados = this.result.featuresEnabled?.length
        ? `Ativamos: ${this.result.featuresEnabled.join(', ')}. `
        : '';
      const desligados = this.result.featuresDisabled?.length
        ? `Desativamos: ${this.result.featuresDisabled.join(', ')}. `
        : '';
      const pagamentos = this.result.paymentMethodsActive?.length
        ? `Formas de pagamento ativas: ${this.result.paymentMethodsActive.join(', ')}.`
        : '';
      return `${criado}${ligados}${desligados}${pagamentos} Já é só usar.`;
    },
  };
}
