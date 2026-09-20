function onboardingWizard() {
  return {
    open: false,
    mode: 'first-run', // 'first-run' | 'reopen'
    step: 0,
    totalSteps: 9,
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
    // é o que o servidor valida e o que decide recursos e catálogo de teste.
    businessTypes: [
      { id: 'restaurante', label: 'Restaurante / lanchonete', icon: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>', hint: 'Lanches, sucos, porções, combo e pedidos no painel da cozinha.' },
      { id: 'padaria', label: 'Padaria / confeitaria', icon: '<path d="M4 13h16a1 1 0 0 1 0 8H4a1 1 0 0 1 0-8Z"/><path d="M6 13c0-3 2-5 6-5s6 2 6 5"/><path d="M9 8V5M15 8V5"/>', hint: 'Pães, salgados, bolo com ficha técnica e pedidos no painel da cozinha.' },
      { id: 'mercado', label: 'Mercado / mercearia', icon: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>', hint: 'Mercearia, hortifrúti, açougue e cesta básica como kit.' },
      { id: 'conveniencia', label: 'Conveniência', icon: '<path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="m3 9 2-6h14l2 6"/><path d="M9 9v12M15 9v12"/>', hint: 'Bebidas, snacks, gelados e recarga de celular (serviço).' },
      { id: 'adega', label: 'Adega / bebidas', icon: '<path d="M8 2h8l-1 7a3 3 0 0 1-6 0Z"/><path d="M12 9v9"/><path d="M9 22h6"/>', hint: 'Vinhos, cervejas, destilados, kit de degustação e combos.' },
      { id: 'roupas', label: 'Roupas / calçados', icon: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>', hint: 'Grades de tamanho/cor, numeração de calçados e ajuste de barra.' },
      { id: 'farmacia', label: 'Farmácia', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>', hint: 'Medicamentos, higiene, vitaminas e kits de conveniência.' },
      { id: 'petshop', label: 'Petshop', icon: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10c-3 0-5 3-5 6a3 3 0 0 0 5 2 4 4 0 0 1 4 0 3 3 0 0 0 5-2c0-3-2-6-5-6Z"/>', hint: 'Rações, acessórios e banho & tosa como serviços.' },
      { id: 'servicos', label: 'Serviços', icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>', hint: 'Hora técnica, visita e manutenção como serviços.' },
      { id: 'outro', label: 'Outro', icon: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>', hint: 'Começa sem produtos de exemplo — você cadastra do seu jeito.' },
    ],
    // Cor de destaque sugerida por ramo (espelho das telas, não vai pro servidor). O ramo
    // escolhido aplica essa cor automaticamente; o lojista continua livre para trocar no
    // passo de interface/cor — a partir daí a escolha dele vence e a sugestão não volta.
    branchColors: {
      restaurante: { theme: 'orange', hex: '#ff8000' },
      padaria: { theme: 'custom', hex: '#b45309' },
      mercado: { theme: 'green', hex: '#16a34a' },
      conveniencia: { theme: 'green', hex: '#16a34a' },
      adega: { theme: 'custom', hex: '#7c3aed' },
      roupas: { theme: 'pink', hex: '#ec4899' },
      farmacia: { theme: 'blue', hex: '#2563eb' },
      petshop: { theme: 'custom', hex: '#0ea5e9' },
      servicos: { theme: 'blue', hex: '#2563eb' },
    },
    // Layout (cartões/menu lateral) é preferência deste computador (localStorage) e nunca
    // vai em `answers` nem no POST de /api/onboarding/provision. Já a COR de destaque é
    // configuração da empresa (tabela `settings`) e é aplicada no servidor — ver
    // partials/theme-init.ejs — para valer em todos os aparelhos que abrem este Kivo.
    uiInterface: (function(){ try { return localStorage.getItem('kivo-interface') || 'cards'; } catch { return 'cards'; } })(),
    uiColorTheme: (window.__kivoColor && window.__kivoColor.theme) || 'orange',
    uiCustomColor: (window.__kivoColor && window.__kivoColor.custom) || '#ff8000',
    // Tema dos ícones (pacote). Único ajuste deste passo que vai para `settings` (vale para
    // a empresa) em vez do localStorage; os cards são os mesmos de Configurações › Interface.
    iconPacks: [],
    iconPackId: 'padrao',
    iconPackStartId: 'padrao',
    iconPackSaving: false,
    iconPackError: '',
    // Vira true quando o lojista escolhe uma cor com as próprias mãos — dali em diante a
    // cor do ramo não sobrescreve mais a preferência dele.
    colorTouched: false,
    chooseInterface(v) {
      this.uiInterface = v;
      try { localStorage.setItem('kivo-interface', v); } catch {}
    },
    // Grava a cor no servidor (settings). Fire-and-forget: o assistente não pode travar
    // por causa disso e a cor já foi aplicada na tela.
    persistColor(theme, hex) {
      try {
        fetch('/api/settings/interface.cor_destaque', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: theme }),
        });
        if (theme === 'custom' && hex) {
          fetch('/api/settings/interface.cor_custom', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: hex }),
          });
        }
      } catch {}
    },
    chooseColorPreset(id) {
      this.colorTouched = true;
      this.uiColorTheme = id;
      var s = document.documentElement.style;
      s.removeProperty('--primary'); s.removeProperty('--icon-color');
      s.removeProperty('--primary-hover'); s.removeProperty('--primary-bg');
      document.documentElement.setAttribute('data-color-theme', id);
      window.__kivoColor = { theme: id, custom: this.uiCustomColor };
      this.persistColor(id);
    },
    chooseCustomColor(hex) {
      this.colorTouched = true;
      this.uiCustomColor = hex; this.uiColorTheme = 'custom';
      document.documentElement.setAttribute('data-color-theme', 'custom');
      window.__kivoApplyCustomColor(hex);
      window.__kivoColor = { theme: 'custom', custom: hex };
      this.persistColor('custom', hex);
    },
    /**
     * Escolhe o tema dos ícones. Não recarrega a página — recarregar fecharia o assistente;
     * os ícones trocam no próximo carregamento (ao concluir). A escolha é gravada na hora,
     * então mesmo que o lojista pule o assistente depois, o tema fica salvo.
     */
    async chooseIconPack(id) {
      if (!id || id === this.iconPackId || this.iconPackSaving) return;
      this.iconPackSaving = true;
      this.iconPackError = '';
      try {
        const r = await fetch('/api/settings/icon-pack', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!r.ok) { this.iconPackError = ((await r.json()) || {}).error || 'Não foi possível aplicar o tema.'; return; }
        this.iconPackId = id;
      } catch {
        this.iconPackError = 'Erro de conexão ao aplicar o tema.';
      } finally {
        this.iconPackSaving = false;
      }
    },
    // Aplica a cor sugerida pelo ramo SEM marcar colorTouched: trocar de ramo ainda pode
    // re-sugerir enquanto o lojista não escolher uma cor manualmente.
    applyBranchColor(branch) {
      var m = this.branchColors[branch];
      if (!m) return;
      var s = document.documentElement.style;
      s.removeProperty('--primary'); s.removeProperty('--icon-color');
      s.removeProperty('--primary-hover'); s.removeProperty('--primary-bg');
      if (m.theme === 'custom') {
        this.uiColorTheme = 'custom'; this.uiCustomColor = m.hex;
        document.documentElement.setAttribute('data-color-theme', 'custom');
        window.__kivoApplyCustomColor(m.hex);
        window.__kivoColor = { theme: 'custom', custom: m.hex };
        this.persistColor('custom', m.hex);
      } else {
        this.uiColorTheme = m.theme;
        document.documentElement.setAttribute('data-color-theme', m.theme);
        window.__kivoColor = { theme: m.theme, custom: this.uiCustomColor };
        this.persistColor(m.theme);
      }
    },
    branchLabel() {
      var t = this.businessTypes.find((b) => b.id === this.answers.businessType);
      return t ? t.label : '';
    },
    branchHasColorSuggestion() {
      return this.mode === 'first-run' && !!this.branchColors[this.answers.businessType];
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
      } catch {
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
      this.colorTouched = false;
      this.iconPackError = '';
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
      } catch {
        // sem status: os campos só começam vazios
      }
      try {
        const r = await fetch('/api/onboarding/payment-methods');
        if (r.ok) {
          this.paymentMethods = await r.json();
          this.answers.activePaymentMethodIds = this.paymentMethods.filter((p) => p.active).map((p) => p.id);
        }
      } catch {
        // segue sem a lista — o passo de pagamento só fica vazio
      }
      try {
        const rf = await fetch('/api/onboarding/features');
        if (rf.ok) this.features = await rf.json();
      } catch {
        // sem catálogo de recursos: o passo fica vazio e o provision cai na recomendação
        // do servidor, que é o mesmo que o assistente sugeriria aqui.
      }
      try {
        const ri = await fetch('/api/settings/icon-packs');
        if (ri.ok) {
          const d = await ri.json();
          this.iconPacks = d.packs || [];
          this.iconPackId = d.current || 'padrao';
          this.iconPackStartId = this.iconPackId;
        }
      } catch {
        // sem catálogo de temas: a seção de tema dos ícones simplesmente não aparece
      }
    },
    close() {
      this.open = false;
      this.$refs.onboardingDlg?.close();
      // O tema dos ícones é renderizado no servidor: só recarregar aplica a troca. Recarrega
      // apenas quando o lojista realmente trocou, para não piscar a tela de quem só abriu.
      if (this.iconPackStartId !== this.iconPackId) location.reload();
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
    STEP_FEATURES: 5,

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

    // ─── Passo 1: ramo ─────────────────────────────────────────────────────────────
    // A escolha do ramo também aplica a cor sugerida (first-run, enquanto o lojista não
    // mexeu na cor) e avança sozinho, como o passo de "onde vai usar".
    chooseBranch(b) {
      this.answers.businessType = b;
      if (this.mode === 'first-run' && !this.colorTouched) this.applyBranchColor(b);
      setTimeout(() => this.next(), 260);
    },

    chooseUsage(v) {
      this.answers.usage = v;
      setTimeout(() => this.next(), 260);
    },

    /** Passo 2 (nome/porte): o nome é o mínimo — o ramo já veio no passo 1. */
    canLeaveDetailsStep() {
      return !!this.answers.businessName.trim();
    },
    leaveDetailsStep() {
      if (!this.answers.businessName.trim()) {
        this.businessError = 'Informe o nome do seu negócio.';
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

    /**
     * Linhas do resumo sobre o catálogo de teste do ramo escolhido. Espelha o que o
     * servidor gera em core/onboarding/demoCatalog.ts e é condicionado aos recursos que
     * ficaram ligados — os mesmos que decidem o que o catálogo inclui de verdade.
     */
    demoHighlights() {
      const bt = this.answers.businessType;
      const on = (k) => this.featureKeys.indexOf(k) !== -1;
      const base = {
        restaurante: ['Cardápio de teste: X-Burger, suco, batata frita e sobremesas'],
        padaria: ['Padaria de teste: pães, salgados, doces e café'],
        mercado: ['Mercado de teste: mercearia, hortifrúti, açougue e limpeza'],
        conveniencia: ['Conveniência de teste: bebidas, snacks e gelados'],
        adega: ['Adega de teste: vinhos, cervejas, destilados e sem álcool'],
        roupas: [],
        farmacia: ['Farmácia de teste: medicamentos, higiene e vitaminas'],
        petshop: ['Petshop de teste: rações, acessórios e brinquedos'],
        servicos: ['Serviços de teste: hora técnica, visita e manutenção'],
      };
      const lines = (base[bt] ?? []).slice();
      if (bt === 'restaurante') {
        if (on('commercial.complementos')) lines.push('Suco com sabor e X-Burger com adicionais');
        if (on('commercial.kits')) lines.push('Combo X-Burger com preço fechado');
        if (on('foodservice.cozinha')) lines.push('X-Burger e batata já vão pro Painel de cozinha');
        if (on('commercial.variantes')) lines.push('Pizza com variações de tamanho e sabor');
      } else if (bt === 'padaria') {
        if (on('commercial.complementos')) lines.push('Café com complementos (chantilly, leite…)');
        if (on('commercial.producao')) lines.push('Bolo de Chocolate com ficha técnica que consome insumos');
        if (on('commercial.kits')) lines.push('Kit Café da Manhã pronto');
        if (on('foodservice.cozinha')) lines.push('Pães, salgados e bolos já vão pro Painel de cozinha');
      } else if (bt === 'mercado') {
        if (on('commercial.kits')) lines.push('Cesta Básica pronta como kit');
        if (on('foodservice.cozinha')) lines.push('Padaria interna e frango assado roteados pra cozinha');
      } else if (bt === 'conveniencia') {
        if (on('commercial.kits')) lines.push('Combo Salgadinho + Refrigerante');
      } else if (bt === 'adega') {
        if (on('commercial.kits')) lines.push('Kit Degustação de Vinhos e Combo de Cervejas');
      } else if (bt === 'roupas') {
        if (on('commercial.variantes')) lines.push('Camiseta, calça e tênis com grade (tamanho/cor e numeração)');
        else lines.push('Roupas, calçados e acessórios');
        lines.push('Ajuste de barra cadastrado como serviço');
      } else if (bt === 'farmacia') {
        if (on('commercial.kits')) lines.push('Kits de higiene prontos');
      } else if (bt === 'petshop') {
        lines.push('Banho e tosa como serviços, sem estoque');
      } else if (bt === 'servicos') {
        if (on('commercial.kits')) lines.push('Pacote de 10 horas como combo');
      }
      return lines;
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
      } catch {
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
      if (this.result.categoriesCreated) parts.push(`${this.result.categoriesCreated} categorias`);
      const criado = parts.length ? `Criamos ${parts.join(', ')}. ` : '';
      const cozinha = this.result.kitchenRoutesCreated
        ? `${this.result.kitchenRoutesCreated} produtos já vão pro Painel de cozinha. `
        : '';
      const ligados = this.result.featuresEnabled?.length
        ? `Ativamos: ${this.result.featuresEnabled.join(', ')}. `
        : '';
      const desligados = this.result.featuresDisabled?.length
        ? `Desativamos: ${this.result.featuresDisabled.join(', ')}. `
        : '';
      const pagamentos = this.result.paymentMethodsActive?.length
        ? `Formas de pagamento ativas: ${this.result.paymentMethodsActive.join(', ')}.`
        : '';
      return `${criado}${cozinha}${ligados}${desligados}${pagamentos} Já é só usar.`;
    },
  };
}

// API pública — usada como x-data="onboardingWizard()" na tela do assistente.
window.onboardingWizard = onboardingWizard;
