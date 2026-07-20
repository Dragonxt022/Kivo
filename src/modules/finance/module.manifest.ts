import type { ModuleManifest } from '../../core/modules/types';

const manifest: ModuleManifest = {
  id: 'finance',
  name: 'Financeiro (caixa e contas)',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [
    { key: 'finance.cash.view', description: 'Visualizar caixa e movimentos' },
    { key: 'finance.cash.open', description: 'Abrir caixa' },
    { key: 'finance.cash.close', description: 'Fechar caixa' },
    { key: 'finance.cash.move', description: 'Suprimento e sangria' },
    { key: 'finance.payables.view', description: 'Visualizar contas a pagar' },
    { key: 'finance.payables.create', description: 'Criar contas a pagar' },
    { key: 'finance.payables.edit', description: 'Editar/cancelar contas a pagar' },
    { key: 'finance.payables.pay', description: 'Pagar contas' },
    { key: 'finance.receivables.view', description: 'Visualizar contas a receber' },
    { key: 'finance.receivables.create', description: 'Criar contas a receber' },
    { key: 'finance.receivables.edit', description: 'Editar/cancelar contas a receber' },
    { key: 'finance.receivables.receive', description: 'Receber contas' },
    { key: 'finance.reports.view', description: 'Visualizar fluxo de caixa e relatórios' },
    { key: 'finance.paymethods.view', description: 'Visualizar formas de pagamento' },
    { key: 'finance.paymethods.edit', description: 'Cadastrar/editar formas de pagamento e taxas' },
    { key: 'finance.paymethods.delete', description: 'Excluir formas de pagamento' },
    { key: 'finance.cash.edit', description: 'Corrigir caixa já fechado (auditado)' },
    { key: 'finance.agreements.view', description: 'Visualizar convênios e faturas' },
    { key: 'finance.agreements.invoice', description: 'Gerar fatura de convênio manualmente' },
    { key: 'finance.reconciliation.view', description: 'Visualizar relatório de saldos negativos pós-sincronização' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  migrations: './migrations',
  setup: './setup',
  menu: [
    { label: 'Caixa', href: '/app/finance/caixa', permission: 'finance.cash.view', description: 'Abertura, fechamento, suprimento e sangria.', icon: 'wallet' },
    { label: 'A pagar', href: '/app/finance/pagar', permission: 'finance.payables.view', description: 'Contas a pagar e vencimentos.', icon: 'credit-card' },
    { label: 'A receber', href: '/app/finance/receber', permission: 'finance.receivables.view', description: 'Contas a receber e vencimentos.', icon: 'dollar-sign' },
    { label: 'Fluxo', href: '/app/finance/fluxo', permission: 'finance.reports.view', description: 'Fluxo de caixa por dia.', icon: 'chart' },
    { label: 'Pagamentos', href: '/app/finance/formas-pagamento', permission: 'finance.paymethods.view', description: 'Formas de pagamento e taxas das maquininhas.', icon: 'credit-card' },
    { label: 'Convênios', href: '/app/finance/convenios', permission: 'finance.agreements.view', description: 'Empresas conveniadas, cobranças pendentes e faturas mensais.', icon: 'receipt' },
    { label: 'Reconciliação', href: '/app/finance/reconciliacao', permission: 'finance.reconciliation.view', description: 'Saldos de crédito/fidelidade que ficaram negativos após sincronizar.', icon: 'shield-check' },
  ],
  // Fase 6a — motor de sincronização (KIVO_PLANO.md §6).
  // opened_by/closed_by/edited_by referenciam `users`, que não sincroniza nesta sub-fase.
  // payment_methods NÃO sincroniza: é configuração por máquina/terminal (cada maquininha
  // pode ter sua própria taxa), seeded independentemente em cada instalação — por isso
  // sale_payments.payment_method_id fica de fora do payload (method_name/method_type/fee_bps
  // já são congelados na própria linha, que é o que realmente importa para o histórico).
  syncTables: [
    { table: 'cash_registers', excludeColumns: ['opened_by', 'closed_by', 'edited_by'] },
    { table: 'payables', foreignKeys: { supplier_id: 'suppliers', dre_category_id: 'dre_categories' } },
    { table: 'receivables', foreignKeys: { customer_id: 'customers', sale_id: 'sales', agreement_company_id: 'agreement_companies' } },
    {
      table: 'cash_movements',
      excludeColumns: ['ref_id', 'user_id'],
      ledgerFor: { parentTable: 'cash_registers', parentColumn: 'register_id' },
    },
    { table: 'agreement_charges', foreignKeys: { sale_id: 'sales', agreement_company_id: 'agreement_companies', receivable_id: 'receivables' } },
  ],
};

export default manifest;
