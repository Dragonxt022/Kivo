import { Router } from 'express';
import {
  requireMobileAuth, loadGrantByToken, setMobileCookie, clearMobileCookie, touchGrant,
  type MobileRequest,
} from '../mobileAuth';
import {
  listEntity, findEntity, dataFreshness, stockBalances,
  type SalePayload, type ProductPayload, type BillPayload, type CashRegisterPayload,
  type QuotePayload, type CustomerPayload,
} from '../mobileData';

/**
 * Kivo Web — o app que o lojista abre no celular. Montado em `/m`.
 *
 * Só leitura, exceto o orçamento (que vira comando para o desktop executar — ver
 * routes/mobileCommands.ts). Todo dado vem de `sync_records`, ou seja, do último sync do
 * computador da loja; por isso o "atualizado há X" aparece em toda tela.
 */
const router = Router();

/** Hoje no fuso de Porto Velho (America/Porto_Velho), o mesmo usado no relógio do desktop. */
function hojeISO(): string {
  return new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
}

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function baseLocals(req: MobileRequest) {
  const fresh = await dataFreshness(req.grant!.companyUuid);
  return { grant: req.grant!, fresh, brl };
}

// ─── Pareamento ────────────────────────────────────────────────────────────────
// Antes de qualquer `requireMobileAuth`: é justamente o que cria a sessão.

router.get('/entrar', (_req, res) => {
  res.render('mobile-entrar');
});

router.get('/sair', (_req, res) => {
  clearMobileCookie(res);
  res.redirect('/m/entrar');
});

/**
 * O link do QR. Valida, guarda o token no cookie e **redireciona para `/m` sem o token**:
 * deixá-lo na barra de endereço o preservaria no histórico do navegador e no cabeçalho
 * `Referer` de qualquer link externo aberto depois.
 */
router.get('/acesso/:token', async (req, res) => {
  const grant = await loadGrantByToken(req.params.token);
  if (!grant) {
    clearMobileCookie(res);
    res.status(401).render('mobile-entrar', { erro: 'Este link não é mais válido. Peça um novo no computador da loja.' });
    return;
  }
  setMobileCookie(res, req.params.token);
  await touchGrant(grant.companyUuid, grant.userUuid);
  res.redirect('/m');
});

router.use(requireMobileAuth);

// ─── Telas ─────────────────────────────────────────────────────────────────────

router.get('/', async (req: MobileRequest, res) => {
  const company = req.grant!.companyUuid;
  const hoje = hojeISO();
  const [sales, registers] = await Promise.all([
    listEntity<SalePayload>(company, 'store.sales', { limit: 500 }),
    listEntity<CashRegisterPayload>(company, 'finance.cash_registers', { limit: 5 }),
  ]);
  const doDia = sales.filter((s) => s.payload.status === 'concluida' && (s.payload.created_at ?? '').startsWith(hoje));
  const totalDia = doDia.reduce((a, s) => a + (s.payload.total_cents ?? 0), 0);
  const caixa = registers.find((r) => r.payload.status === 'aberto') ?? null;

  res.render('mobile-inicio', {
    ...(await baseLocals(req)),
    totalDia,
    qtdDia: doDia.length,
    ticketMedio: doDia.length ? Math.round(totalDia / doDia.length) : 0,
    caixa: caixa?.payload ?? null,
    ultimas: doDia.slice(0, 5),
  });
});

router.get('/vendas', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('store.sales.view')) return res.redirect('/m');
  const sales = await listEntity<SalePayload>(req.grant!.companyUuid, 'store.sales', { limit: 100 });
  res.render('mobile-vendas', { ...(await baseLocals(req)), sales });
});

router.get('/vendas/:uuid', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('store.sales.view')) return res.redirect('/m');
  const sale = await findEntity<SalePayload>(req.grant!.companyUuid, 'store.sales', String(req.params.uuid));
  if (!sale) return res.status(404).render('mobile-inicio', { ...(await baseLocals(req)), naoEncontrado: true, totalDia: 0, qtdDia: 0, ticketMedio: 0, caixa: null, ultimas: [] });
  // Itens guardam o uuid do produto (o id local não vale entre máquinas): resolver o nome.
  const produtos = await listEntity<ProductPayload>(req.grant!.companyUuid, 'commercial.products', { limit: 5000 });
  const nomePorUuid = new Map(produtos.map((p) => [p.uuid, p.payload.name]));
  res.render('mobile-venda', { ...(await baseLocals(req)), sale, nomePorUuid });
});

router.get('/estoque', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('commercial.products.view')) return res.redirect('/m');
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const [produtos, saldos] = await Promise.all([
    listEntity<ProductPayload>(req.grant!.companyUuid, 'commercial.products', { limit: 5000 }),
    stockBalances(req.grant!.companyUuid),
  ]);
  const lista = produtos
    // Mesma regra do PDV: o produto-pai de uma grade não é vendável nem tem estoque próprio.
    .filter((p) => !(p.payload.product_type === 'variante' && !p.payload.parent_product_id))
    .filter((p) => p.payload.active === 1 && p.payload.track_stock === 1)
    .filter((p) => !q || p.payload.name.toLowerCase().includes(q) || (p.payload.sku ?? '').toLowerCase().includes(q))
    .map((p) => ({ uuid: p.uuid, ...p.payload, saldo: saldos.get(p.uuid) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.render('mobile-estoque', {
    ...(await baseLocals(req)),
    q,
    produtos: lista.slice(0, 200),
    abaixoMinimo: lista.filter((p) => p.saldo <= p.min_stock).length,
  });
});

router.get('/financeiro', async (req: MobileRequest, res) => {
  const podePagar = req.grant!.permissions.includes('finance.payables.view');
  const podeReceber = req.grant!.permissions.includes('finance.receivables.view');
  if (!podePagar && !podeReceber) return res.redirect('/m');
  const company = req.grant!.companyUuid;
  const [payables, receivables] = await Promise.all([
    podePagar ? listEntity<BillPayload>(company, 'finance.payables', { limit: 300 }) : Promise.resolve([]),
    podeReceber ? listEntity<BillPayload>(company, 'finance.receivables', { limit: 300 }) : Promise.resolve([]),
  ]);
  const emAberto = (rows: typeof payables) =>
    rows.filter((r) => r.payload.status !== 'pago' && r.payload.status !== 'cancelado')
      .sort((a, b) => (a.payload.due_date ?? '').localeCompare(b.payload.due_date ?? ''));
  res.render('mobile-financeiro', {
    ...(await baseLocals(req)),
    hoje: hojeISO(),
    payables: emAberto(payables).slice(0, 50),
    receivables: emAberto(receivables).slice(0, 50),
    podePagar, podeReceber,
  });
});

router.get('/orcamentos', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('store.quotes.view')) return res.redirect('/m');
  const quotes = await listEntity<QuotePayload>(req.grant!.companyUuid, 'store.quotes', { limit: 100 });
  res.render('mobile-orcamentos', {
    ...(await baseLocals(req)),
    quotes,
    podeCriar: req.grant!.permissions.includes('store.quotes.create'),
  });
});

router.get('/orcamentos/novo', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('store.quotes.create')) return res.redirect('/m/orcamentos');
  const company = req.grant!.companyUuid;
  const [produtos, clientes] = await Promise.all([
    listEntity<ProductPayload>(company, 'commercial.products', { limit: 5000 }),
    listEntity<CustomerPayload>(company, 'commercial.customers', { limit: 2000 }),
  ]);
  res.render('mobile-orcamento-novo', {
    ...(await baseLocals(req)),
    produtos: produtos
      .filter((p) => p.payload.active === 1)
      .filter((p) => !(p.payload.product_type === 'variante' && !p.payload.parent_product_id))
      .map((p) => ({ uuid: p.uuid, name: p.payload.name, sku: p.payload.sku, price_cents: p.payload.price_cents }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    clientes: clientes
      .map((c) => ({ uuid: c.uuid, name: c.payload.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

export default router;
