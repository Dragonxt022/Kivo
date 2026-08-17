function onboardingWizard() {
  return {
    open: false,
    mode: 'first-run', // 'first-run' | 'reopen'
    step: 0,
    totalSteps: 8,
    answers: {
      usage: null, businessType: null, activePaymentMethodIds: [],
      businessName: '', employeeRange: null,
    },
    businessError: '',

    // Faixas de porte. Não se sobrepõem — ver OnboardingEmployeeRange em
    // core/onboarding/service.ts para o porquê (faixa cumulativa inutiliza a pesquisa).
    employeeRanges: [
      { id: '1-5', label: 'Até 5' },
      { id: '6-50', label: '6 a 50' },
      { id: '51-100', label: '51 a 100' },
      { id: '100+', label: 'Mais de 100' },
    ],

    // Espelha OnboardingBusinessType (core/onboarding/service.ts) — os ids têm de bater,
    // é o que o servidor valida e o que decide os recursos recomendados.
    businessTypes: [
      { id: 'restaurante', label: 'Restaurante / lanchonete', icon: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>' },
      { id: 'padaria', label: 'Padaria / confeitaria', icon: '<path d="M4 13h16a1 1 0 0 1 0 8H4a1 1 0 0 1 0-8Z"/><path d="M6 13c0-3 2-5 6-5s6 2 6 5"/><path d="M9 8V5M15 8V5"/>' },
      { id: 'mercado', label: 'Mercado / mercearia', icon: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>' },
      { id: 'conveniencia', label: 'Conveniência', icon: '<path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="m3 9 2-6h14l2 6"/><path d="M9 9v12M15 9v12"/>' },
      { id: 'adega', label: 'Adega / bebidas', icon: '<path d="M8 2h8l-1 7a3 3 0 0 1-6 0Z"/><path d="M12 9v9"/><path d="M9 22h6"/>' },
      { id: 'roupas', label: 'Roupas / calçados', icon: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>' },
      { id: 'farmacia', label: 'Farmácia', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>' },
      { id: 'petshop', label: 'Petshop', icon: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10c-3 0-5 3-5 6a3 3 0 0 0 5 2 4 4 0 0 1 4 0 3 3 0 0 0 5-2c0-3-2-6-5-6Z"/>' },
      { id: 'servicos', label: 'Serviços', icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>' },
      { id: 'outro', label: 'Outro', icon: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>' },
    ],
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
      this.businessError = '';
      this.result = null;
      this.answers = {
        usage: null, businessType: null, activePaymentMethodIds: [],
        businessName: '', employeeRange: null,
      };
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
      // Pré-preenche com o que já está cadastrado. Vale principalmente ao REABRIR o
      // assistente (e depois de um reset de fábrica, que preserva os dados da empresa):
      // fazer o lojista redigitar o nome do próprio negócio seria trabalho à toa.
      try {
        const rs = await fetch('/api/onboarding/status');
        if (rs.ok) {
          const s = await rs.json();
          const d = s.data ?? s;
          if (d.businessName) this.answers.businessName = d.businessName;
          if (d.businessType) this.answers.businessType = d.businessType;
          if (d.employeeRange) this.answers.employeeRange = d.employeeRange;
          if (d.usage) this.answers.usage = d.usage;
        }
      } catch (e) {
        // sem status: os campos só começam vazios
      }
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

    /** Nome e ramo são o mínimo para o assistente configurar alguma coisa. */
    canLeaveBusinessStep() {
      return !!this.answers.businessName.trim() && !!this.answers.businessType;
    },
    leaveBusinessStep() {
      if (!this.answers.businessName.trim()) {
        this.businessError = 'Informe o nome do seu negócio.';
        return;
      }
      if (!this.answers.businessType) {
        this.businessError = 'Escolha o ramo do seu negócio.';
        return;
      }
      this.businessError = '';
      this.next();
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
      // No primeiro acesso o nome é obrigatório (o servidor também exige). Ao REABRIR, um
      // campo vazio significa "não mexe no que já está gravado", não "apaga".
      if (createDemoData && !this.answers.businessName.trim()) {
        this.error = 'Volte e informe o nome do seu negócio.';
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
            businessName: this.answers.businessName.trim(),
            employeeRange: this.answers.employeeRange,
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
