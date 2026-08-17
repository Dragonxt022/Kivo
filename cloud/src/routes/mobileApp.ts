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
import { calcular, PERIODOS, type Periodo } from '../mobileAnalytics';

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

/**
 * Endereço público desta instalação, para montar o link que o cliente vai abrir.
 *
 * Vem dos cabeçalhos do proxy reverso (`X-Forwarded-*`) e não de uma constante: em
 * desenvolvimento isto roda em `http://localhost:4000` e em produção atrás do HTTPS de
 * `kivo.buscamais.org`. Fixar o domínio faria o link do celular apontar para o lugar
 * errado em um dos dois.
 */
function baseUrl(req: MobileRequest): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return `${proto}://${host}`;
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

// ─── Clientes e cobrança ───────────────────────────────────────────────────────
/**
 * O módulo que faltava: o financeiro lista contas a receber soltas, uma por linha, e nunca
 * responde a pergunta que o lojista faz de verdade — "quem me deve, quanto, e há quanto
 * tempo?". Aqui a conta é agrupada POR CLIENTE, que é a unidade da cobrança.
 */
interface ClienteResumo {
  uuid: string;
  nome: string;
  telefone: string | null;
  documento: string | null;
  abertoCents: number;
  vencidoCents: number;
  contas: number;
  /** Dias de atraso da conta mais antiga em aberto — é o que decide a ordem da lista. */
  diasAtraso: number;
}

function diasEntre(deISO: string, ateISO: string): number {
  const a = Date.parse(deISO + 'T00:00:00Z');
  const b = Date.parse(ateISO + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** Em aberto = ainda deve algo. Conta paga ou cancelada não é cobrança. */
function emAbertoBill(p: BillPayload): boolean {
  return p.status !== 'pago' && p.status !== 'cancelado';
}

/** Quanto ainda falta receber de UMA conta, descontando o que já foi recebido em partes. */
function saldoBill(p: BillPayload): number {
  const recebido = p.received_cents ?? p.paid_cents ?? 0;
  return Math.max(0, (p.amount_cents ?? 0) - recebido);
}

router.get('/clientes', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('commercial.customers.view')) return res.redirect('/m');
  const company = req.grant!.companyUuid;
  const podeCobranca = req.grant!.permissions.includes('finance.receivables.view');
  const hoje = hojeISO();

  const [customers, receivables] = await Promise.all([
    listEntity<CustomerPayload>(company, 'commercial.customers', { limit: 5000 }),
    podeCobranca
      ? listEntity<BillPayload>(company, 'finance.receivables', { limit: 5000 })
      : Promise.resolve([]),
  ]);

  const porCliente = new Map<string, { aberto: number; vencido: number; contas: number; atraso: number }>();
  for (const r of receivables) {
    const p = r.payload;
    if (!p.customer_id || !emAbertoBill(p)) continue;
    const saldo = saldoBill(p);
    if (saldo <= 0) continue;
    const atual = porCliente.get(p.customer_id) ?? { aberto: 0, vencido: 0, contas: 0, atraso: 0 };
    atual.aberto += saldo;
    atual.contas += 1;
    if (p.due_date && p.due_date < hoje) {
      atual.vencido += saldo;
      atual.atraso = Math.max(atual.atraso, diasEntre(p.due_date, hoje));
    }
    porCliente.set(p.customer_id, atual);
  }

  const lista: ClienteResumo[] = customers
    .filter((c) => c.payload.active !== 0)
    .map((c) => {
      const f = porCliente.get(c.uuid);
      return {
        uuid: c.uuid,
        nome: c.payload.name,
        telefone: c.payload.phone ?? null,
        documento: c.payload.document ?? null,
        abertoCents: f?.aberto ?? 0,
        vencidoCents: f?.vencido ?? 0,
        contas: f?.contas ?? 0,
        diasAtraso: f?.atraso ?? 0,
      };
    })
    // Quem está vencido há mais tempo primeiro, depois quem deve mais, e só então em ordem
    // alfabética: a lista abre já na ordem em que a cobrança precisa acontecer.
    .sort((a, b) =>
      b.diasAtraso - a.diasAtraso
      || b.vencidoCents - a.vencidoCents
      || b.abertoCents - a.abertoCents
      || a.nome.localeCompare(b.nome, 'pt-BR'));

  res.render('mobile-clientes', {
    ...(await baseLocals(req)),
    clientes: lista,
    podeCobranca,
    totalAberto: lista.reduce((s, c) => s + c.abertoCents, 0),
    totalVencido: lista.reduce((s, c) => s + c.vencidoCents, 0),
    devedores: lista.filter((c) => c.abertoCents > 0).length,
  });
});

router.get('/clientes/:uuid', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('commercial.customers.view')) return res.redirect('/m');
  const company = req.grant!.companyUuid;
  const podeCobranca = req.grant!.permissions.includes('finance.receivables.view');
  const uuid = String(req.params.uuid);
  const hoje = hojeISO();

  const cliente = await findEntity<CustomerPayload>(company, 'commercial.customers', uuid);
  if (!cliente) return res.redirect('/m/clientes');

  const [receivables, sales] = await Promise.all([
    podeCobranca ? listEntity<BillPayload>(company, 'finance.receivables', { limit: 5000 }) : Promise.resolve([]),
    req.grant!.permissions.includes('store.sales.view')
      ? listEntity<SalePayload>(company, 'store.sales', { limit: 1000 })
      : Promise.resolve([]),
  ]);

  const doCliente = receivables.filter((r) => r.payload.customer_id === uuid);
  const abertas = doCliente
    .filter((r) => emAbertoBill(r.payload) && saldoBill(r.payload) > 0)
    .map((r) => ({
      uuid: r.uuid,
      descricao: r.payload.description,
      vencimento: r.payload.due_date,
      saldoCents: saldoBill(r.payload),
      totalCents: r.payload.amount_cents ?? 0,
      vencida: !!r.payload.due_date && r.payload.due_date < hoje,
      diasAtraso: r.payload.due_date && r.payload.due_date < hoje ? diasEntre(r.payload.due_date, hoje) : 0,
    }))
    .sort((a, b) => (a.vencimento ?? '').localeCompare(b.vencimento ?? ''));

  const quitadas = doCliente
    .filter((r) => !emAbertoBill(r.payload) || saldoBill(r.payload) <= 0)
    .sort((a, b) => (b.payload.due_date ?? '').localeCompare(a.payload.due_date ?? ''))
    .slice(0, 10);

  // O histórico de compras usa `customer_name` porque `sales` não declara FK de cliente no
  // manifesto — é o que existe, e serve para dar contexto ao cobrar.
  const nome = cliente.payload.name;
  const compras = sales
    .filter((s) => (s.payload.customer_name ?? '').trim().toLowerCase() === nome.trim().toLowerCase())
    .sort((a, b) => (b.payload.created_at ?? '').localeCompare(a.payload.created_at ?? ''))
    .slice(0, 10);

  res.render('mobile-cliente', {
    ...(await baseLocals(req)),
    c: cliente.payload,
    uuid,
    abertas,
    quitadas,
    compras,
    podeCobranca,
    abertoCents: abertas.reduce((s, r) => s + r.saldoCents, 0),
    vencidoCents: abertas.filter((r) => r.vencida).reduce((s, r) => s + r.saldoCents, 0),
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
  // Validade em 15 dias: é o padrão do comércio e poupa um toque no calendário do
  // celular, que é o campo mais chato de preencher com o dedo.
  const validade = new Date(Date.now() - 4 * 3600e3 + 15 * 86400e3).toISOString().slice(0, 10);
  res.render('mobile-orcamento-novo', {
    ...(await baseLocals(req)),
    validadeSugerida: validade,
    // Mesma permissão que o desktop exige em `createQuote`. Esconder o campo de quem não
    // pode é usabilidade; quem forçar o valor recebe a recusa do serviço lá.
    podeDesconto: req.grant!.permissions.includes('store.sales.discount'),
    produtos: produtos
      .filter((p) => p.payload.active === 1)
      .filter((p) => !(p.payload.product_type === 'variante' && !p.payload.parent_product_id))
      .map((p) => ({
        uuid: p.uuid, name: p.payload.name, sku: p.payload.sku,
        barcode: p.payload.barcode, price_cents: p.payload.price_cents,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    clientes: clientes
      .filter((c) => c.payload.active !== 0)
      .map((c) => ({ uuid: c.uuid, name: c.payload.name, phone: c.payload.phone, document: c.payload.document }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

/**
 * Detalhe do orçamento — a tela de onde ele é enviado ao cliente.
 *
 * Precisa vir DEPOIS de `/orcamentos/novo`: `:uuid` é curinga e engoliria "novo".
 */
router.get('/orcamentos/:uuid', async (req: MobileRequest, res) => {
  if (!req.grant!.permissions.includes('store.quotes.view')) return res.redirect('/m');
  const company = req.grant!.companyUuid;
  const quote = await findEntity<QuotePayload>(company, 'store.quotes', String(req.params.uuid));
  if (!quote) return res.redirect('/m/orcamentos');
  const produtos = await listEntity<ProductPayload>(company, 'commercial.products', { limit: 5000 });
  const nomePorUuid = new Map(produtos.map((p) => [p.uuid, p.payload.name]));
  res.render('mobile-orcamento', {
    ...(await baseLocals(req)),
    quote,
    nomePorUuid,
    // O link que vai para o cliente é absoluto: ele abre no WhatsApp, fora do app.
    linkPublico: `${baseUrl(req)}/orcamento/${company}/${quote.uuid}`,
  });
});

router.get('/analiticos', async (req: MobileRequest, res) => {
  // Sem permissão de ver vendas não há analítico que faça sentido — o faturamento é a
  // espinha da tela inteira.
  if (!req.grant!.permissions.includes('store.reports.view') && !req.grant!.permissions.includes('store.sales.view')) {
    return res.redirect('/m');
  }
  const periodo = String(req.query.p ?? 'semana') as Periodo;
  const escolhido = PERIODOS.some((p) => p.chave === periodo) ? periodo : 'semana';
  const dados = await calcular(req.grant!.companyUuid, escolhido);
  res.render('mobile-analiticos', {
    ...(await baseLocals(req)),
    a: dados,
    periodos: PERIODOS,
    verFinanceiro: req.grant!.permissions.includes('finance.receivables.view')
      || req.grant!.permissions.includes('finance.payables.view'),
    verEstoque: req.grant!.permissions.includes('commercial.products.view'),
  });
});

export default router;
