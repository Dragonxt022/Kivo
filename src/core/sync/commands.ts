import { getSqlite } from '../database/connection';
import { impersonate } from '../auth/systemContext';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';
import { getService } from '../services/registry';
import { validateLicense } from '../license/service';
import { canUseWebApp } from '../license/plans';

/**
 * Executa, no desktop, os comandos que chegaram do Kivo Web.
 *
 * Por que a intenção vem pela fila em vez de o celular escrever direto na nuvem: o pull do
 * sync insere linhas direto nas tabelas, sem passar pelos services de domínio. Um orçamento
 * criado assim não teria validação de produto, nem preço resolvido pela tabela do cliente —
 * `pricing.resolvePrice` só roda aqui. Então a nuvem guarda o pedido e esta função chama o
 * mesmo `createQuote` que a tela do desktop chama.
 *
 * A execução acontece no nome de quem pediu (`impersonate`): permissão e trilha de auditoria
 * saem corretas, e não como "sistema".
 */

export interface PendingCommand {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  created_by_user_uuid: string;
}

interface QuoteItemPayload {
  productUuid: string;
  qty: number;
}

interface QuoteCommandPayload {
  items?: QuoteItemPayload[];
  customerUuid?: string | null;
  customerName?: string | null;
  validUntil?: string | null;
  notes?: string | null;
}

/** Serviço de orçamentos exposto pelo módulo store (nunca importar o módulo direto). */
interface StoreQuotesService {
  createQuote: (
    req: import('express').Request,
    input: {
      items: { productId: number; qty: number }[];
      customerId?: number;
      customerName?: string;
      validUntil?: string;
      notes?: string;
    },
  ) => { ok: true; id: number; totalCents: number } | { ok: false; error: string };
}

function db() {
  return getSqlite();
}

/** O celular só conhece uuid — `id` é local a cada máquina e não vale entre instalações. */
function localIdByUuid(table: string, uuid: string | null | undefined): number | null {
  if (!uuid) return null;
  const row = db()
    .prepare(`SELECT id FROM ${table} WHERE uuid = ? AND deleted_at IS NULL`)
    .get(uuid) as { id: number } | undefined;
  return row?.id ?? null;
}

type HandlerResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

function handleQuoteCreate(cmd: PendingCommand): HandlerResult {
  const req = impersonate(localIdByUuid('users', cmd.created_by_user_uuid) ?? 0);
  if (!req) return { ok: false, error: 'O usuário que pediu não existe mais nesta máquina ou está inativo.' };
  if (!req.user.permissions.has('store.quotes.create')) {
    return { ok: false, error: 'O cargo deste usuário não permite mais criar orçamentos.' };
  }

  const p = cmd.payload as QuoteCommandPayload;
  if (!Array.isArray(p.items) || !p.items.length) return { ok: false, error: 'Orçamento sem itens.' };

  const items: { productId: number; qty: number }[] = [];
  for (const item of p.items) {
    const productId = localIdByUuid('products', item.productUuid);
    if (!productId) return { ok: false, error: 'Um dos produtos não existe mais no cadastro.' };
    items.push({ productId, qty: Number(item.qty) });
  }

  const customerId = localIdByUuid('customers', p.customerUuid) ?? undefined;
  const quotes = getService<StoreQuotesService>('store.quotes');
  // Sem `unitPriceCents`: o preço é resolvido aqui pelo mesmo caminho da tela (tabela de
  // preço do cliente, faixa de quantidade). O celular só sugere produto e quantidade.
  const result = quotes.createQuote(req, {
    items,
    customerId,
    customerName: !customerId && p.customerName ? p.customerName : undefined,
    validUntil: p.validUntil ?? undefined,
    notes: p.notes ?? undefined,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, result: { quoteId: result.id, totalCents: result.totalCents } };
}

const HANDLERS: Record<string, (cmd: PendingCommand) => HandlerResult> = {
  'store.quote.create': handleQuoteCreate,
};

/**
 * Aplica UM comando, sem tocar na rede — separado de `drainCommands` para poder ser testado
 * sem subir a nuvem, e para que uma falha de handler nunca vire falha de transporte.
 *
 * Comando de tipo desconhecido vira erro, não fica pendente: uma versão do app mais antiga
 * que a nuvem travaria a fila para sempre, e o celular esperaria sem resposta.
 */
export function applyCommand(cmd: PendingCommand): HandlerResult {
  const handler = HANDLERS[cmd.kind];
  if (!handler) {
    return { ok: false, error: `Esta versão do Kivo não conhece o comando "${cmd.kind}". Atualize o sistema.` };
  }
  try {
    return handler(cmd);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

let draining = false;

/**
 * Busca os pendentes e aplica. Chamado pelo evento SSE (caminho normal, ~1s depois do
 * celular pedir) e no fim de cada ciclo de sync (rede de segurança, se o canal caiu).
 *
 * A trava `draining` impede que os dois gatilhos rodem juntos e apliquem o mesmo comando
 * duas vezes — o `ack` também é idempotente do lado da nuvem, mas duplicar aqui já teria
 * criado dois orçamentos.
 */
export async function drainCommands(): Promise<{ aplicados: number; erros: number } | null> {
  if (draining) return null;
  if (!canUseWebApp(validateLicense().plan)) return null;
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return null;

  draining = true;
  let aplicados = 0;
  let erros = 0;
  try {
    const r = await fetch(`${base}/api/commands/pending`, { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const { commands } = (await r.json()) as { commands: PendingCommand[] };

    for (const cmd of commands) {
      const outcome = applyCommand(cmd);
      if (outcome.ok) aplicados++;
      else erros++;

      await fetch(`${base}/api/commands/${cmd.id}/ack`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          outcome.ok ? { status: 'aplicado', result: outcome.result } : { status: 'erro', result: { error: outcome.error } },
        ),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {
        // Sem o ack o comando volta como pendente na próxima rodada. O orçamento já foi
        // criado, então reaplicar duplicaria — por isso a mensagem, para ficar rastreável.
        console.error(`[commands] ack não confirmado do comando ${cmd.id}; pode reaplicar.`);
      });
    }
  } catch (e) {
    console.error('[commands] falha ao buscar/aplicar:', (e as Error).message);
    return null;
  } finally {
    draining = false;
  }
  if (aplicados || erros) console.log(`[commands] aplicados=${aplicados} erros=${erros}`);
  return { aplicados, erros };
}
