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
  const street = text(source, ['dsRua', 'rua', 'logradouro', 'dsEndereco']);
  const number = text(source, ['nrRua', 'numero', 'nrEndereco']);
  const complement = text(source, ['dsComplemento', 'complemento']);
  const district = text(source, ['dsBairro', 'bairro']);
  const reference = text(source, ['dsReferencia', 'referencia', 'pontoReferencia']);
  const parts: string[] = [];
  if (street) parts.push(number ? `${street}, ${number}` : street);
  if (complement) parts.push(complement);
  if (district) parts.push(district);
  if (reference) parts.push(`Ref.: ${reference}`);
  return parts.join(' — ');
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

export interface OrderSummary {
  id: string;
  customer: string;
  phone: string;
  address: string;
  totalCents: number | null;
  totalRaw: string;
  status: string;
  statusId: string;
  payment: string;
  createdAt: string;
  deliveryType: string;
  notes: string;
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
  const totalValue = pick(source, [
    'vlPedido',
    'vlTotal',
    'valorTotal',
    'total',
    'vlTotalPedido',
    'valor',
  ]);
  const declaredCount = Number(text(source, ['qtItens', 'qtdItens', 'itensCount', 'nrItens']));
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
    status: text(source, ['dsSituacao', 'situacao', 'dsStatus', 'status', 'nomeSituacao']),
    statusId: text(source, ['idSituacao', 'situacaoId', 'statusId']),
    payment: text(source, [
      'dsPagamento',
      'formaPagamento',
      'dsFormaPagamento',
      'pagamento',
      'dsTipoPagamento',
    ]),
    createdAt: text(source, [
      'dtPedido',
      'dtCriacao',
      'dataPedido',
      'created_at',
      'dtCadastro',
      'data',
    ]),
    deliveryType: text(source, ['dsEntrega', 'tipoEntrega', 'dsTipoEntrega', 'idEntrega']),
    notes: text(source, ['dsObservacao', 'observacao', 'obs']),
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

export async function fetchOrder(orderId: number): Promise<{ order: OrderSummary; raw: unknown }> {
  const config = getMaisDeliveryConfig();
  const { body } = await call(12, { idPedido: orderId, ...restaurantFields(config) });
  return { order: normalizeOrder(firstOrderRecord(body)), raw: body };
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
  return { raw: body };
}
