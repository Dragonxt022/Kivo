/**
 * Analíticos do Kivo Web — os números que respondem "como vai o negócio".
 *
 * Tudo é calculado a partir de `sync_records`, a mesma fonte do resto do painel (ver
 * mobileData.ts): não há tabela de agregação nem job noturno. Para o volume de uma loja
 * — meses de venda cabem em alguns milhares de linhas — somar em memória é mais simples e
 * mais honesto que manter uma projeção que pode divergir do que o desktop mandou.
 *
 * Duas decisões que aparecem em vários pontos deste arquivo:
 *
 * - **Só venda `concluida` conta.** Venda cancelada continua em `sync_records` (o desktop
 *   faz soft-delete/estorno, não apaga), e somá-la inflaria o faturamento.
 * - **O período anterior tem a MESMA duração**, terminando onde o atual começa. Comparar
 *   "este mês" (que pode ter 9 dias corridos) com o mês passado inteiro daria uma queda
 *   fictícia todo dia 2.
 */
import { listEntity, stockBalances, type SalePayload, type ProductPayload, type BillPayload } from './mobileData';

export type Periodo = 'hoje' | 'semana' | 'mes';

export const PERIODOS: { chave: Periodo; rotulo: string; dias: number }[] = [
  { chave: 'hoje', rotulo: 'Hoje', dias: 1 },
  { chave: 'semana', rotulo: '7 dias', dias: 7 },
  { chave: 'mes', rotulo: '30 dias', dias: 30 },
];

/**
 * O Kivo trabalha no fuso de Porto Velho (UTC-4), mesmo relógio do desktop. Usar UTC aqui
 * jogaria as vendas da noite para o dia seguinte no relatório.
 */
const FUSO_MS = 4 * 3600e3;

function diaISO(deslocamentoDias = 0): string {
  return new Date(Date.now() - FUSO_MS - deslocamentoDias * 86400e3).toISOString().slice(0, 10);
}

/** Lista de dias (mais antigo → mais recente) que compõem o período. */
function diasDoPeriodo(dias: number): string[] {
  return Array.from({ length: dias }, (_, i) => diaISO(dias - 1 - i));
}

export interface Fatia {
  rotulo: string;
  valorCents: number;
  qtd: number;
  cor: string;
}

export interface Ranking {
  nome: string;
  qtd: number;
  valorCents: number;
}

export interface Serie {
  rotulo: string;
  valorCents: number;
}

export interface Analiticos {
  periodo: Periodo;
  rotuloPeriodo: string;
  faturamentoCents: number;
  vendas: number;
  ticketMedioCents: number;
  descontoCents: number;
  /** Variação percentual do faturamento contra o período anterior de mesma duração. */
  variacao: number | null;
  variacaoAnterior: number;
  serie: Serie[];
  pagamentos: Fatia[];
  topProdutos: Ranking[];
  aReceberCents: number;
  aReceberVencidoCents: number;
  aPagarCents: number;
  aPagarVencidoCents: number;
  estoqueCritico: { nome: string; saldo: number; minimo: number }[];
}

/** Paleta fixa por posição — a mesma forma de pagamento mantém a cor entre períodos. */
const CORES = ['#ff8000', '#2f6bff', '#00a37a', '#e5484d', '#7c5cff', '#f5a524', '#8a8a98'];

function somaConcluidas(vendas: { payload: SalePayload }[]): number {
  return vendas.reduce((a, v) => a + (v.payload.total_cents ?? 0), 0);
}

export async function calcular(companyUuid: string, periodo: Periodo): Promise<Analiticos> {
  const def = PERIODOS.find((p) => p.chave === periodo) ?? PERIODOS[1];
  const dias = def.dias;

  const [vendasBrutas, produtos, receber, pagar, saldos] = await Promise.all([
    // O limite cobre com folga 60 dias de uma loja movimentada. É explícito porque
    // `listEntity` tem um teto padrão de 200, que truncaria o mês silenciosamente.
    listEntity<SalePayload>(companyUuid, 'store.sales', { limit: 20000 }),
    listEntity<ProductPayload>(companyUuid, 'commercial.products', { limit: 5000 }),
    listEntity<BillPayload>(companyUuid, 'finance.receivables', { limit: 2000 }),
    listEntity<BillPayload>(companyUuid, 'finance.payables', { limit: 2000 }),
    stockBalances(companyUuid),
  ]);

  const concluidas = vendasBrutas.filter((v) => v.payload.status === 'concluida');
  const doDia = (v: { payload: SalePayload }) => (v.payload.created_at ?? '').slice(0, 10);

  const janela = diasDoPeriodo(dias);
  const inicio = janela[0];
  const fim = janela[janela.length - 1];
  const noPeriodo = concluidas.filter((v) => doDia(v) >= inicio && doDia(v) <= fim);

  // Anterior: mesma duração, terminando na véspera do início do atual.
  const janelaAnterior = diasDoPeriodo(dias * 2).slice(0, dias);
  const inicioAnt = janelaAnterior[0];
  const fimAnt = janelaAnterior[janelaAnterior.length - 1];
  const noAnterior = concluidas.filter((v) => doDia(v) >= inicioAnt && doDia(v) <= fimAnt);

  const faturamentoCents = somaConcluidas(noPeriodo);
  const anteriorCents = somaConcluidas(noAnterior);

  // Série do gráfico. No período de 1 dia, mostrar uma coluna só não diz nada — então
  // "Hoje" desenha os últimos 7 dias para dar contexto ao número do topo.
  const diasSerie = dias === 1 ? diasDoPeriodo(7) : janela;
  const porDia = new Map<string, number>(diasSerie.map((d) => [d, 0]));
  for (const v of concluidas) {
    const d = doDia(v);
    if (porDia.has(d)) porDia.set(d, (porDia.get(d) ?? 0) + (v.payload.total_cents ?? 0));
  }
  // Em 30 dias, um rótulo por coluna vira uma mancha ilegível: mostra só de 5 em 5.
  const passo = diasSerie.length > 14 ? 5 : 1;
  const serie: Serie[] = diasSerie.map((d, i) => ({
    rotulo: i % passo === 0 || i === diasSerie.length - 1 ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '',
    valorCents: porDia.get(d) ?? 0,
  }));

  // Formas de pagamento. `sale_payments` existe quando a venda foi dividida; quando não,
  // o método único do cabeçalho é a fonte — ignorar isso perderia toda venda simples.
  const porPagamento = new Map<string, { valor: number; qtd: number }>();
  for (const v of noPeriodo) {
    const partes = v.payload.sale_payments?.length
      ? v.payload.sale_payments.map((p) => ({ nome: p.method_name || 'Outro', valor: p.amount_cents ?? 0 }))
      : [{ nome: v.payload.payment_method || 'Outro', valor: v.payload.total_cents ?? 0 }];
    for (const p of partes) {
      const atual = porPagamento.get(p.nome) ?? { valor: 0, qtd: 0 };
      porPagamento.set(p.nome, { valor: atual.valor + p.valor, qtd: atual.qtd + 1 });
    }
  }
  const pagamentos: Fatia[] = [...porPagamento.entries()]
    .sort((a, b) => b[1].valor - a[1].valor)
    .map(([rotulo, v], i) => ({ rotulo, valorCents: v.valor, qtd: v.qtd, cor: CORES[i % CORES.length] }));

  // Produtos mais vendidos. Os itens guardam o uuid do produto (id local não vale entre
  // máquinas), então o nome vem do cadastro — e produto já excluído mantém o histórico.
  const nomePorUuid = new Map(produtos.map((p) => [p.uuid, p.payload.name]));
  const porProduto = new Map<string, { qtd: number; valor: number }>();
  for (const v of noPeriodo) {
    for (const item of v.payload.sale_items ?? []) {
      const chave = item.product_id ?? '';
      if (!chave) continue;
      const atual = porProduto.get(chave) ?? { qtd: 0, valor: 0 };
      porProduto.set(chave, {
        qtd: atual.qtd + (Number(item.qty) || 0),
        valor: atual.valor + (item.total_cents ?? 0),
      });
    }
  }
  const topProdutos: Ranking[] = [...porProduto.entries()]
    .sort((a, b) => b[1].valor - a[1].valor)
    .slice(0, 8)
    .map(([uuid, v]) => ({ nome: nomePorUuid.get(uuid) ?? 'Produto removido', qtd: v.qtd, valorCents: v.valor }));

  const hoje = diaISO();
  const emAberto = (rows: typeof receber) =>
    rows.filter((r) => r.payload.status !== 'pago' && r.payload.status !== 'cancelado');
  const restante = (b: BillPayload) => Math.max(0, (b.amount_cents ?? 0) - (b.paid_cents ?? 0));
  const soma = (rows: typeof receber, vencido: boolean) =>
    emAberto(rows)
      .filter((r) => (vencido ? (r.payload.due_date ?? '') < hoje : true))
      .reduce((a, r) => a + restante(r.payload), 0);

  return {
    periodo: def.chave,
    rotuloPeriodo: def.rotulo,
    faturamentoCents,
    vendas: noPeriodo.length,
    ticketMedioCents: noPeriodo.length ? Math.round(faturamentoCents / noPeriodo.length) : 0,
    descontoCents: noPeriodo.reduce((a, v) => a + (v.payload.discount_cents ?? 0), 0),
    // `null` quando não houve período anterior: mostrar "+100%" contra zero seria inventar
    // um crescimento que não aconteceu.
    variacao: anteriorCents > 0 ? Math.round(((faturamentoCents - anteriorCents) / anteriorCents) * 100) : null,
    variacaoAnterior: anteriorCents,
    serie,
    pagamentos,
    topProdutos,
    aReceberCents: soma(receber, false),
    aReceberVencidoCents: soma(receber, true),
    aPagarCents: soma(pagar, false),
    aPagarVencidoCents: soma(pagar, true),
    // Só quem controla estoque e está ativo. O produto-pai de uma grade é excluído pela
    // mesma razão do PDV: ele não é vendável nem tem saldo próprio — quem tem são as
    // variantes filhas.
    estoqueCritico: produtos
      .filter((p) => p.payload.active === 1 && p.payload.track_stock === 1)
      .filter((p) => !(p.payload.product_type === 'variante' && !p.payload.parent_product_id))
      .map((p) => ({ nome: p.payload.name, saldo: saldos.get(p.uuid) ?? 0, minimo: Number(p.payload.min_stock) || 0 }))
      .filter((p) => p.saldo <= p.minimo)
      .sort((a, b) => a.saldo - b.saldo)
      .slice(0, 8),
  };
}
