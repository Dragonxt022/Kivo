import {
  getMaisDeliveryConfig,
  getMaisDeliveryCredentials,
  type MaisDeliveryConfig,
} from './settings';

/**
 * Cliente da API pública do Mais Delivery.
 *
 * Todas as operações são POST no MESMO endpoint e se diferenciam por `nrOperacao`:
 *   1  informações do estabelecimento
 *   2  listar pedidos (com idRestaurante)
 *   3  alterar situação do pedido
 *   4  lançar pedido
 *   7  listar situações
 *   8  listar formas de pagamento
 *   10 ativar/desativar produto
 *   11 alterar valor do produto
 *   12 detalhes do pedido
 *   14 listar pedidos sem idRestaurante (por idMarketplace)
 *
 * Nesta entrega usamos 1, 2, 3, 7, 8, 12 e 14. A coleção pública não traz exemplos
 * de resposta; por isso o parse é tolerante a envelope (`dados`/`data`/...) e a
 * normalização procura os nomes de campo mais prováveis. A tela de configuração
 * mostra a resposta bruta do teste de conexão para ajustarmos o mapeamento se o
 * formato real divergir.
 */

const API_URL = 'https://maisdeliveryapp.com.br/oapi/v2/controller/operacao_oapi_v2_publica.php';
const REQUEST_TIMEOUT_MS = 20000;

export type MaisDeliveryOperation = 1 | 2 | 3 | 4 | 7 | 8 | 10 | 11 | 12 | 14;

export class MaisDeliveryError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'MaisDeliveryError';
    this.statusCode = statusCode;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Busca um campo ignorando caixa, acentos de separação e underscores (`idPedido`,
 * `id_pedido` e `IDPEDIDO` são a mesma chave). Devolve o primeiro valor não vazio.
 */
export function pick(source: unknown, names: string[]): unknown {
  if (!isRecord(source)) return undefined;
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(source)) fields.set(normalizeKey(key), value);
  for (const name of names) {
    const value = fields.get(normalizeKey(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function text(source: unknown, names: string[], fallback = ''): string {
  const value = pick(source, names);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** "100,00", "1.234,56", 100 ou "R$ 100.00" → centavos. */
export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  if (typeof value !== 'string') return null;
  let raw = value.trim().replace(/[^\d,.-]/g, '');
  if (!raw) return null;
  const negative = raw.startsWith('-');
  raw = raw.replace(/-/g, '');
  let normalized: string;
  if (raw.includes(',')) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
    normalized = raw.replace(/\./g, '');
  } else {
    normalized = raw;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((negative ? -parsed : parsed) * 100);
}

function formatPhone(ddd: string, phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return phone.trim();
  const dddDigits = ddd.replace(/\D/g, '');
  // Número local tem 8/9 dígitos; só a partir de 10 ele já carrega o DDD. O teste
  // pelo prefixo sozinho errava um celular local que começasse pelos mesmos dígitos
  // do DDD (ex.: DDD 99 + 99999-9999).
  const full = dddDigits && digits.length <= 9 ? dddDigits + digits : digits;
  if (full.length === 11) return `(${full.slice(0, 2)}) ${full.slice(2, 7)}-${full.slice(7)}`;
  if (full.length === 10) return `(${full.slice(0, 2)}) ${full.slice(2, 6)}-${full.slice(6)}`;
  return phone.trim();
}

function buildAddress(source: unknown): string {
  // Alguns retornos trazem `dsEndereco` já montado (mais legível) e `arrEndereco` com as
  // partes. Preferimos o texto pronto quando existe; as partes entram como fallback.
  const full = text(source, ['dsEndereco', 'enderecoCompleto', 'dsEnderecoCompleto']);
  const nested = pick(source, ['arrEndereco', 'endereco', 'address']);
  const base = isRecord(nested) ? nested : source;
  const street = text(base, ['dsRua', 'rua', 'logradouro']);
  const number = text(base, ['nrRua', 'numero', 'nrEndereco']);
  const complement = text(base, ['dsComplemento', 'complemento']);
  const district = text(base, ['dsBairro', 'bairro']);
  const city = text(base, ['dsCidade', 'cidade', 'nmCidade']);
  const reference = text(source, ['dsReferencia', 'referencia', 'pontoReferencia']);
  const parts: string[] = [];
  if (full) {
    parts.push(full);
  } else if (street) {
    parts.push(number ? `${street}, ${number}` : street);
    if (complement) parts.push(`(${complement})`);
    if (district) parts.push(district);
    if (city) parts.push(city);
  }
  if (reference && !full.toLowerCase().includes(reference.toLowerCase())) {
    parts.push(`Ref.: ${reference}`);
  }
  return parts.join(' — ');
}

/** "100,00", 100 ou null — soma apenas os valores que existem. */
function sumMoney(values: unknown[]): number | null {
  let total = 0;
  let found = false;
  for (const value of values) {
    const cents = parseMoneyToCents(value);
    if (cents !== null) {
      total += cents;
      found = true;
    }
  }
  return found ? total : null;
}

/**
 * Converte a data da API para um ISO de relógio de parede (`YYYY-MM-DDTHH:mm:ss`, sem
 * fuso). A API usa `dd/mm/aaaa hh:mm:ss` no horário local da loja; converter para UTC e
 * exibir com `fmtDateTimeLocal` somaria o offset outra vez. O ISO local também ordena
 * corretamente e é entendido por `new Date()` no navegador.
 */
function toIsoDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const localIso = (date: Date): string | null => {
    if (Number.isNaN(date.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (br) {
    const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = br;
    return localIso(
      new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)),
    );
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (iso) {
    const [, yyyy, mm, dd, hh = '00', min = '00', ss = '00'] = iso;
    return localIso(
      new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)),
    );
  }
  return localIso(new Date(value));
}

/** O pedido pode vir dentro de `pedido`/`order`; o topo tem prioridade. */
function mergeOrder(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const nested = pick(raw, ['pedido', 'order', 'dadosPedido']);
  if (isRecord(nested)) return { ...nested, ...raw };
  return raw;
}

export function unwrap(body: unknown): unknown {
  if (!isRecord(body)) return body;
  for (const key of [
    'dados',
    'data',
    'resultado',
    'result',
    'retorno',
    'payload',
    'response',
    'conteudo',
  ]) {
    const value = pick(body, [key]);
    if (value !== undefined && value !== null) {
      if (isRecord(value) || Array.isArray(value)) return unwrap(value);
      return value;
    }
  }
  return body;
}

function itemsArray(source: unknown): unknown[] {
  const value = pick(source, [
    'itens',
    'items',
    'produtos',
    'pedidoItens',
    'produtosPedido',
    'itensPedido',
    'carrinho',
    'listaItens',
    'dsDetalhe',
    'detalhe',
    'dsItens',
  ]);
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* string livre, não é JSON */
    }
  }
  // Alguns formatos embrulham os itens num objeto (`dsDetalhe: { itens: [...] }`).
  if (isRecord(value)) {
    for (const key of ['itens', 'items', 'produtos', 'lista', 'detalhe']) {
      const nested = pick(value, [key]);
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

export interface OrderItemSummary {
  name: string;
  qty: string;
  unitCents: number | null;
  totalCents: number | null;
  notes: string;
  raw: unknown;
}

export interface OrderHistoryEvent {
  title: string;
  time: string;
  detail: string;
}

function stripHistoryTags(raw: string): string[] {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * `dsHistorico` chega como HTML (`<br/>` entre os eventos). Guardamos texto puro para a
 * tela renderizar com `x-text` — sem `x-html`, sem depender de sanitização.
 */
function parseHistory(raw: string): OrderHistoryEvent[] {
  if (!raw) return [];
  const events: OrderHistoryEvent[] = [];
  const seen = new Set<string>();
  for (const line of stripHistoryTags(raw)) {
    if (/^tempo total de atendimento/i.test(line)) continue;
    const match = /^(.*?)\s+às\s+(\d{2}:\d{2})\s*(.*)$/i.exec(line);
    const title = (match ? match[1] : line).replace(/[.\s]+$/, '').trim();
    const time = match ? match[2] : '';
    const detail = match ? match[3].replace(/[.\s]+$/, '').trim() : '';
    const key = `${title}|${time}|${detail}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    events.push({ title, time, detail });
  }
  // A API devolve do mais antigo para o mais recente; a linha do tempo fica melhor
  // com o acontecimento atual no topo.
  return events.reverse();
}

function historyNote(raw: string): string {
  if (!raw) return '';
  const line = stripHistoryTags(raw).find((part) => /^tempo total de atendimento/i.test(part));
  return line ? line.replace(/\.$/, '') : '';
}

export interface OrderSummary {
  id: string;
  customer: string;
  phone: string;
  address: string;
  totalCents: number | null;
  totalRaw: string;
  subtotalCents: number | null;
  deliveryFeeCents: number | null;
  discountCents: number | null;
  status: string;
  statusId: string;
  payment: string;
  paymentId: string;
  createdAt: string;
  createdAtIso: string | null;
  deliveryType: string;
  notes: string;
  reference: string;
  origin: string;
  restaurant: string;
  driver: string;
  driverPickupAt: string;
  history: string;
  historyEvents: OrderHistoryEvent[];
  historyNote: string;
  cancelReason: string;
  externalCode: string;
  coupon: string;
  table: string;
  command: string;
  onlinePayment: string;
  customerIsNew: boolean;
  permission: string;
  permissionMessage: string;
  itemCount: number;
  items: OrderItemSummary[];
  raw: unknown;
}

function normalizeItems(source: unknown): OrderItemSummary[] {
  return itemsArray(source)
    .filter(isRecord)
    .map((item) => ({
      name: text(item, ['dsNome', 'nome', 'dsProduto', 'produto', 'descricao', 'dsDescricao']),
      qty: text(item, ['qtde', 'quantidade', 'qtd', 'qt', 'nrQuantidade']),
      unitCents: parseMoneyToCents(
        pick(item, ['vlItem', 'vlUnitario', 'valor', 'preco', 'vlPreco']),
      ),
      totalCents: parseMoneyToCents(pick(item, ['vlTotal', 'total', 'valorTotal', 'vlTotalItem'])),
      notes: text(item, ['dsObservacao', 'observacao', 'obs', 'dsComplemento']),
      raw: item,
    }));
}

export function normalizeOrder(raw: unknown): OrderSummary {
  const source = mergeOrder(raw);
  const items = normalizeItems(source);
  // `vlTotal` é o total efetivamente cobrado (inclui entrega); `vlPedido` é o subtotal.
  // A ordem importa: usar `vlPedido` antes fazia a tela mostrar R$ 18,00 num pedido de
  // R$ 23,00, como aconteceu no primeiro teste com a API real.
  const totalValue = pick(source, [
    'vlTotal',
    'vlTotalPedido',
    'valorTotal',
    'total',
    'vlPedido',
    'valor',
  ]);
  const subtotalValue = pick(source, ['vlPedido', 'subtotal', 'valorSubtotal', 'vlSubtotal']);
  const deliveryValue = pick(source, ['vlEntrega', 'taxaEntrega', 'vlTaxaEntrega', 'valorEntrega']);
  const discountValue = sumMoney([
    pick(source, ['vlDescontoCupom', 'descontoCupom']),
    pick(source, ['vlDescontoPromocao', 'descontoPromocao']),
    pick(source, ['vlDescontoEntrega', 'descontoEntrega']),
  ]);
  const declaredCount = Number(text(source, ['qtItens', 'qtdItens', 'itensCount', 'nrItens']));
  const createdAt = text(source, [
    'dtPedido',
    'dtCriacao',
    'dataPedido',
    'created_at',
    'dtCadastro',
    'data',
  ]);
  const history = text(source, ['dsHistorico', 'historico']);
  return {
    id: text(source, ['idPedido', 'id', 'nrPedido', 'codigo', 'pedidoId']),
    customer: text(source, [
      'dsNome',
      'nomeCliente',
      'dsCliente',
      'cliente',
      'nome',
      'dsNomeCliente',
    ]),
    phone: formatPhone(
      text(source, ['nrDDD', 'ddd']),
      text(source, ['nrTelefone', 'telefone', 'dsTelefone', 'nrCelular', 'celular', 'fone']),
    ),
    address: buildAddress(source),
    totalCents: parseMoneyToCents(totalValue),
    totalRaw:
      typeof totalValue === 'string' ? totalValue : totalValue != null ? String(totalValue) : '',
    subtotalCents: parseMoneyToCents(subtotalValue),
    deliveryFeeCents: parseMoneyToCents(deliveryValue),
    discountCents: discountValue,
    status: text(source, ['dsSituacao', 'situacao', 'dsStatus', 'status', 'nomeSituacao']),
    statusId: text(source, ['idSituacao', 'situacaoId', 'statusId']),
    payment: text(source, [
      'dsPagamentoDesc',
      'dsPagamento',
      'formaPagamento',
      'dsFormaPagamento',
      'pagamento',
      'dsTipoPagamento',
    ]),
    paymentId: text(source, ['idPagamento', 'pagamentoId', 'idFormaPagamento']),
    createdAt,
    createdAtIso: toIsoDate(createdAt),
    deliveryType: text(source, ['dsEntrega', 'tipoEntrega', 'dsTipoEntrega', 'idEntrega']),
    notes: text(source, ['dsObservacao', 'observacao', 'obs']),
    reference: text(source, ['dsReferencia', 'referencia', 'pontoReferencia']),
    origin: text(source, ['dsOrigem', 'origem']),
    restaurant: text(source, ['dsRestaurante', 'restaurante', 'nomeRestaurante']),
    driver: text(source, ['dsEntregador', 'entregador', 'nomeEntregador']),
    driverPickupAt: text(source, ['dtEntregadorPegou', 'dataEntregadorPegou']),
    history,
    historyEvents: parseHistory(history),
    historyNote: historyNote(history),
    cancelReason: text(source, ['dsMotivoCancelamento', 'motivoCancelamento']),
    externalCode: text(source, ['dsExternoCode', 'codigoExterno', 'externalCode']),
    coupon: text(source, ['dsCupom', 'cupom']),
    table: text(source, ['dsMesa', 'mesa']),
    command: text(source, ['dsComanda', 'comanda']),
    onlinePayment: text(source, [
      'dsGatewayPagamentoOnline',
      'gatewayPagamentoOnline',
      'dsPagamentoOnline',
    ]),
    customerIsNew: /^(sim|1|true)$/i.test(text(source, ['flgClienteNovo', 'clienteNovo'])),
    permission: text(source, ['flgPermissao', 'permissao']),
    permissionMessage: text(source, ['dsPermissao', 'mensagemPermissao']),
    itemCount: items.length || (Number.isFinite(declaredCount) ? declaredCount : 0),
    items,
    raw,
  };
}

export function normalizeOrderCollection(body: unknown): OrderSummary[] {
  const data = unwrap(body);
  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (isRecord(data)) {
    const candidate = pick(data, ['pedidos', 'orders', 'itens', 'lista', 'resultados']);
    if (Array.isArray(candidate)) {
      list = candidate;
    } else if (isRecord(candidate)) {
      const single = pick(candidate, ['idPedido', 'nrPedido', 'pedidoId']);
      list = single ? [candidate] : Object.values(candidate).filter(isRecord);
    } else if (pick(data, ['idPedido', 'nrPedido', 'pedidoId'])) {
      list = [data];
    } else {
      for (const value of Object.values(data)) {
        if (Array.isArray(value)) {
          list = value;
          break;
        }
      }
    }
  }
  return list.filter(isRecord).map(normalizeOrder);
}

export function firstOrderRecord(body: unknown): unknown {
  const data = unwrap(body);
  if (Array.isArray(data)) return data[0] ?? {};
  if (isRecord(data)) {
    const candidate = pick(data, ['pedidos', 'orders', 'itens', 'lista']);
    if (Array.isArray(candidate)) return candidate[0] ?? data;
    if (isRecord(candidate)) return candidate;
    return data;
  }
  return {};
}

export interface StatusOption {
  id: string;
  name: string;
  raw: unknown;
}

function asList(body: unknown, names: string[]): unknown[] {
  const data = unwrap(body);
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  const candidate = pick(data, names);
  if (Array.isArray(candidate)) return candidate;
  if (isRecord(candidate)) return Object.values(candidate).filter(isRecord);
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeOptions(
  body: unknown,
  names: string[],
  idNames: string[],
  labelNames: string[],
): StatusOption[] {
  const list = asList(body, names);
  const options = list
    .filter(isRecord)
    .map((item) => ({
      id: text(item, idNames),
      name: text(item, labelNames),
      raw: item,
    }))
    .filter((item) => item.id || item.name);
  if (options.length) return options;

  // Algumas APIs devolvem { "1": "Pendente", "2": "Em preparo" }.
  const data = unwrap(body);
  if (isRecord(data)) {
    const entries = Object.entries(data).filter(([, value]) => typeof value === 'string');
    if (entries.length) return entries.map(([id, name]) => ({ id, name: String(name), raw: name }));
  }
  return [];
}

export function normalizeStatuses(body: unknown): StatusOption[] {
  return normalizeOptions(
    body,
    ['situacoes', 'status', 'statuses', 'lista', 'dados'],
    ['idSituacao', 'id', 'codigo', 'idStatus'],
    ['dsSituacao', 'nome', 'descricao', 'dsStatus', 'situacao'],
  );
}

export function normalizePaymentMethods(body: unknown): StatusOption[] {
  return normalizeOptions(
    body,
    ['formasPagamento', 'formas', 'pagamentos', 'paymentMethods', 'lista', 'dados'],
    ['idPagamento', 'id', 'codigo'],
    ['dsPagamento', 'dsFormaPagamento', 'nome', 'descricao', 'formaPagamento'],
  );
}

export interface EstablishmentSummary {
  name: string;
  document: string;
  phone: string;
  address: string;
  raw: unknown;
}

function firstRecord(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return isRecord(data[0]) ? data[0] : null;
  if (!isRecord(data)) return null;
  for (const key of ['estabelecimento', 'loja', 'restaurante', 'empresa']) {
    const value = pick(data, [key]);
    if (isRecord(value)) return value;
  }
  return data;
}

export function normalizeEstablishment(body: unknown): EstablishmentSummary {
  const record = firstRecord(unwrap(body)) ?? {};
  return {
    name: text(record, [
      'dsNome',
      'nome',
      'dsNomeFantasia',
      'fantasia',
      'razaoSocial',
      'dsRazaoSocial',
    ]),
    document: text(record, ['nrCNPJ', 'cnpj', 'documento', 'nrDocumento']),
    phone: formatPhone(
      text(record, ['nrDDD', 'ddd']),
      text(record, ['nrTelefone', 'telefone', 'fone', 'nrCelular', 'celular']),
    ),
    address: buildAddress(record),
    raw: body,
  };
}

function responseMessage(body: unknown, fallback: string): string {
  return text(body, ['mensagem', 'message', 'erro', 'error', 'dsMensagem', 'descricao'], fallback);
}

function bodyIndicatesError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const success = pick(body, ['success', 'sucesso']);
  if (success === false) return responseMessage(body, 'A API recusou a operação.');

  const status = pick(body, ['status']);
  if (status === false) return responseMessage(body, 'A API recusou a operação.');
  if (
    typeof status === 'string' &&
    ['erro', 'error', 'falha', 'failed'].includes(status.toLowerCase())
  ) {
    return responseMessage(body, 'A API recusou a operação.');
  }
  if (typeof status === 'number' && status >= 400) {
    return responseMessage(body, `A API respondeu com status ${status}.`);
  }

  const code = pick(body, ['codigo', 'code']);
  if (typeof code === 'number' && code >= 400) {
    return responseMessage(body, `A API respondeu com código ${code}.`);
  }

  const error = pick(body, ['erro', 'error']);
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

function authorizationHeader(basicAuth: string): string {
  return /^basic\s+/i.test(basicAuth) ? basicAuth : `Basic ${basicAuth}`;
}

/**
 * Monta o corpo comum e faz a chamada. Só inclui `idRestaurante`/`idMarketplace`
 * quando o chamador pediu — a operação 14, por exemplo, não aceita restaurante.
 */
async function call(
  operation: MaisDeliveryOperation,
  extra: Record<string, unknown> = {},
): Promise<{ body: unknown; data: unknown }> {
  const config = getMaisDeliveryConfig();
  const credentials = getMaisDeliveryCredentials();
  if (!credentials) {
    throw new MaisDeliveryError(
      'Credenciais não configuradas ou ilegíveis. Salve o Access token e o Basic Auth novamente.',
      400,
    );
  }
  if (!config.empresaIntegrada) {
    throw new MaisDeliveryError('Informe o idEmpresaIntegrada nas configurações.', 400);
  }

  const payload: Record<string, unknown> = {
    nrOperacao: operation,
    sandBox: config.sandbox,
    idEmpresaIntegrada: config.empresaIntegrada,
    idOrigem: 11,
    ...extra,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Accesstoken: credentials.accessToken,
        Authorization: authorizationHeader(credentials.basicAuth),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MaisDeliveryError('A API do Mais Delivery demorou demais para responder.', 504);
    }
    throw new MaisDeliveryError('Não foi possível conectar à API do Mais Delivery.', 502);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let body: unknown = {};
  if (rawText.trim()) {
    try {
      body = JSON.parse(rawText);
    } catch {
      if (!response.ok) {
        throw new MaisDeliveryError(
          `A API do Mais Delivery respondeu HTTP ${response.status} com conteúdo inesperado.`,
          502,
        );
      }
      throw new MaisDeliveryError(
        'A API do Mais Delivery respondeu um conteúdo que não é JSON.',
        502,
      );
    }
  }

  if (!response.ok) {
    throw new MaisDeliveryError(
      responseMessage(body, `A API do Mais Delivery respondeu HTTP ${response.status}.`),
      response.status >= 500 ? 502 : 400,
    );
  }

  const apiError = bodyIndicatesError(body);
  if (apiError) throw new MaisDeliveryError(apiError, 400);

  return { body, data: unwrap(body) };
}

/**
 * Detalhe, situações, formas de pagamento, estabelecimento e alteração de situação
 * exigem `idRestaurante` na documentação. O `idMarketplace` só substitui o restaurante
 * na listagem sem restaurante (operação 14); enviá-lo nas outras operações não é o
 * contrato da API, então falhamos com uma mensagem clara antes da chamada.
 */
function restaurantFields(config: MaisDeliveryConfig): Record<string, unknown> {
  if (config.restaurante) return { idRestaurante: config.restaurante };
  throw new MaisDeliveryError(
    'Informe o idRestaurante nas configurações para detalhar ou alterar pedidos do Mais Delivery.',
    400,
  );
}

export interface OrdersQuery {
  from: string;
  to: string;
  statusIds?: number[];
}

/**
 * A listagem da API devolve só os IDs; os dados completos vêm da operação 12. Como a
 * tela precisa hidratar dezenas de pedidos de uma vez, guardamos o detalhe por 60s e
 * deduplicamos chamadas simultâneas para o mesmo pedido. O cache é só em memória: nada
 * de pedido do cliente em disco.
 */
const ORDER_CACHE_TTL_MS = 60_000;
const ORDER_CACHE_MAX = 600;

interface CachedOrder {
  fetchedAt: number;
  order: OrderSummary;
  raw: unknown;
}

const orderCache = new Map<number, CachedOrder>();
const orderInflight = new Map<number, Promise<{ order: OrderSummary; raw: unknown }>>();

function cacheOrder(orderId: number, order: OrderSummary, raw: unknown): void {
  orderCache.set(orderId, { fetchedAt: Date.now(), order, raw });
  while (orderCache.size > ORDER_CACHE_MAX) {
    const oldest = orderCache.keys().next().value;
    if (oldest === undefined) break;
    orderCache.delete(oldest);
  }
}

function cachedOrder(orderId: number): CachedOrder | null {
  const cached = orderCache.get(orderId);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt >= ORDER_CACHE_TTL_MS) {
    orderCache.delete(orderId);
    return null;
  }
  // LRU: reinserta no fim para a limpeza tirar primeiro o menos usado.
  orderCache.delete(orderId);
  orderCache.set(orderId, cached);
  return cached;
}

/** `fresh` ignora o cache (usado pelo botão Atualizar). Sem id, limpa tudo. */
export function clearOrderCache(orderId?: number): void {
  if (orderId === undefined) orderCache.clear();
  else orderCache.delete(orderId);
}

export async function fetchOrders(
  query: OrdersQuery,
): Promise<{ orders: OrderSummary[]; raw: unknown }> {
  const config = getMaisDeliveryConfig();
  let operation: MaisDeliveryOperation;
  const extra: Record<string, unknown> = {
    idSituacao: query.statusIds ?? [],
    dtInicio: `${query.from} 00:00:00`,
    dtFim: `${query.to} 23:59:59`,
    idPedido: [],
  };

  // Com restaurante, a operação 2 é a mais específica. Sem restaurante, a 14 lista
  // por marketplace (id da cidade) — é o único caminho documentado nesse cenário.
  if (config.restaurante) {
    operation = 2;
    extra.idRestaurante = config.restaurante;
  } else if (config.marketplace) {
    operation = 14;
    extra.idMarketplace = config.marketplace;
  } else {
    throw new MaisDeliveryError(
      'Informe o idRestaurante ou o idMarketplace nas configurações.',
      400,
    );
  }

  const { body } = await call(operation, extra);
  return { orders: normalizeOrderCollection(body), raw: body };
}

export async function fetchOrder(
  orderId: number,
  options: { fresh?: boolean } = {},
): Promise<{ order: OrderSummary; raw: unknown }> {
  if (!options.fresh) {
    const cached = cachedOrder(orderId);
    if (cached) return { order: cached.order, raw: cached.raw };
  }

  const existing = orderInflight.get(orderId);
  if (existing) return existing;

  const request = (async (): Promise<{ order: OrderSummary; raw: unknown }> => {
    const config = getMaisDeliveryConfig();
    const { body } = await call(12, { idPedido: orderId, ...restaurantFields(config) });
    const order = normalizeOrder(firstOrderRecord(body));
    cacheOrder(orderId, order, body);
    return { order, raw: body };
  })();

  orderInflight.set(orderId, request);
  try {
    return await request;
  } finally {
    orderInflight.delete(orderId);
  }
}

export interface OrdersDetailsResult {
  orders: OrderSummary[];
  failed: Array<{ id: number; error: string }>;
}

/**
 * Busca vários detalhes com concorrência limitada. A operação 12 é uma chamada por
 * pedido; sem o limite, um período de 30 dias abriria dezenas de conexões simultâneas
 * na API do marketplace.
 */
export async function fetchOrdersDetails(
  ids: number[],
  options: { concurrency?: number; fresh?: boolean } = {},
): Promise<OrdersDetailsResult> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) return { orders: [], failed: [] };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8, unique.length));
  const orders: OrderSummary[] = new Array(unique.length);
  const failed: Array<{ id: number; error: string }> = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const index = cursor++;
      const id = unique[index];
      try {
        const result = await fetchOrder(id, { fresh: options.fresh });
        orders[index] = result.order;
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    orders: orders.filter((order): order is OrderSummary => Boolean(order)),
    failed,
  };
}

export async function fetchStatuses(): Promise<{ statuses: StatusOption[]; raw: unknown }> {
  const config = getMaisDeliveryConfig();
  const { body } = await call(7, restaurantFields(config));
  return { statuses: normalizeStatuses(body), raw: body };
}

export async function fetchPaymentMethods(): Promise<{ methods: StatusOption[]; raw: unknown }> {
  const config = getMaisDeliveryConfig();
  const { body } = await call(8, restaurantFields(config));
  return { methods: normalizePaymentMethods(body), raw: body };
}

export async function fetchEstablishment(): Promise<{
  establishment: EstablishmentSummary;
  raw: unknown;
}> {
  const config = getMaisDeliveryConfig();
  const { body } = await call(1, restaurantFields(config));
  return { establishment: normalizeEstablishment(body), raw: body };
}

export async function changeOrderStatus(
  orderId: number,
  statusId: number,
  reason = '',
): Promise<{ raw: unknown }> {
  const config = getMaisDeliveryConfig();
  const { body } = await call(3, {
    idPedido: orderId,
    idSituacao: statusId,
    dsMotivo: reason,
    ...restaurantFields(config),
  });
  // A próxima leitura precisa refletir a situação nova, não o cache anterior.
  clearOrderCache(orderId);
  return { raw: body };
}
