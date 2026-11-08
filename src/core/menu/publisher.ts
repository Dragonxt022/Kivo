import { createHash } from 'node:crypto';
import { getSqlite } from '../database/connection';
import { hasCapability } from '../capabilities/service';
import { validateLicense } from '../license/service';
import { canUseQrOrder } from '../license/plans';
import { getService, hasService } from '../services/registry';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';
import { settingsRepository } from '../repositories/SettingsRepository';
import { createLogger } from '../logger';

/**
 * Publicação do menu público usado pelo pedido via QR na mesa.
 *
 * Por que não reutilizar o sync: o Trial não tem `sync/push` (`canSaveToCloud` exclui
 * trial), e o recurso precisa funcionar no teste. Então o app monta um snapshot seguro
 * (só o que é público) e o envia para `/api/menu/publish`, liberado para Trial/Diamante.
 * Isso não abre backup/sync geral para o trial.
 *
 * O snapshot também é a fonte das miniaturas: `imageId` é o `catalog_image_id` do produto,
 * resolvido/carregado pelo fluxo de imagens do Cloud (ver core/catalog/submissionQueue.ts).
 */

const log = createLogger('menu-publico');

const SETTING_HASH = 'pedido_qr.menu_hash';
const SETTING_PUBLISHED_AT = 'pedido_qr.publicado_em';
const PUBLISH_INTERVAL_MS = 45_000;

interface PricingService {
  resolvePrice: (productId: number, qty: number, customerId?: number | null) => { unitCents: number };
}

interface MenuProductRow {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  price_cents: number;
  category_uuid: string | null;
  category_name: string | null;
  catalog_image_id: number | null;
}

interface ComplementRow {
  product_id: number;
  group_uuid: string;
  group_name: string;
  min_select: number;
  max_select: number | null;
  group_sort: number;
  option_uuid: string;
  option_name: string;
  option_price_cents: number;
  option_sort: number;
}

interface PublicComplementGroup {
  groupUuid: string;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  sortOrder: number;
  options: { productUuid: string; name: string; priceCents: number; sortOrder: number }[];
}

interface PublicMenuItem {
  productUuid: string;
  name: string;
  description: string | null;
  priceCents: number;
  categoryUuid: string | null;
  categoryName: string | null;
  imageId: number | null;
  sortOrder: number;
  complements: PublicComplementGroup[];
}

interface PublicMenuSnapshot {
  enabled: boolean;
  items: PublicMenuItem[];
}

function buildSnapshot(enabled: boolean): PublicMenuSnapshot {
  const db = getSqlite();
  const products = db
    .prepare(
      `SELECT p.id, p.uuid, p.name, p.description, p.price_cents,
              c.uuid AS category_uuid, c.name AS category_name, p.catalog_image_id
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.deleted_at IS NULL
        WHERE p.deleted_at IS NULL AND p.active = 1 AND p.visivel_cardapio = 1
          AND p.product_type <> 'complemento'
          AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)
        ORDER BY COALESCE(c.name, 'zzz'), p.name, p.id`,
    )
    .all() as MenuProductRow[];

  if (!products.length) return { enabled, items: [] };

  // Grupos/opções de TODOS os produtos visíveis numa consulta só (sem IN gigante).
  const complements = db
    .prepare(
      `SELECT pcg.product_id, cg.uuid AS group_uuid, cg.name AS group_name,
              cg.min_select, cg.max_select, pcg.sort_order AS group_sort,
              op.uuid AS option_uuid, op.name AS option_name,
              COALESCE(i.price_override_cents, op.price_cents) AS option_price_cents,
              i.sort_order AS option_sort
         FROM product_complement_groups pcg
         JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
         JOIN complement_group_items i ON i.group_id = cg.id AND i.deleted_at IS NULL
         JOIN products op ON op.id = i.product_id AND op.deleted_at IS NULL AND op.active = 1
         JOIN products bp ON bp.id = pcg.product_id
        WHERE pcg.deleted_at IS NULL
          AND bp.deleted_at IS NULL AND bp.active = 1 AND bp.visivel_cardapio = 1
        ORDER BY pcg.product_id, pcg.sort_order, cg.name, i.sort_order, i.id`,
    )
    .all() as ComplementRow[];

  const groupsByProduct = new Map<number, Map<string, PublicComplementGroup>>();
  for (const row of complements) {
    let groups = groupsByProduct.get(row.product_id);
    if (!groups) {
      groups = new Map();
      groupsByProduct.set(row.product_id, groups);
    }
    let group = groups.get(row.group_uuid);
    if (!group) {
      group = {
        groupUuid: row.group_uuid,
        name: row.group_name,
        minSelect: Number(row.min_select) || 0,
        maxSelect: row.max_select == null ? null : Number(row.max_select),
        sortOrder: Number(row.group_sort) || 0,
        options: [],
      };
      groups.set(row.group_uuid, group);
    }
    group.options.push({
      productUuid: row.option_uuid,
      name: row.option_name,
      priceCents: Number(row.option_price_cents) || 0,
      sortOrder: Number(row.option_sort) || 0,
    });
  }

  const pricing = hasService('commercial.pricing')
    ? getService<PricingService>('commercial.pricing')
    : null;

  const items: PublicMenuItem[] = products.map((p, idx) => {
    // Mesmo preço que o PDV/comanda resolveria para um cliente anônimo na quantidade 1.
    // Faixas de preço por quantidade não são aplicadas no cardápio público nesta versão.
    let priceCents = Number(p.price_cents) || 0;
    if (pricing) {
      try {
        priceCents = pricing.resolvePrice(p.id, 1, null).unitCents;
      } catch {
        // preço de catálogo é a reserva segura
      }
    }
    return {
      productUuid: p.uuid,
      name: p.name,
      description: p.description,
      priceCents,
      categoryUuid: p.category_uuid,
      categoryName: p.category_name,
      imageId: p.catalog_image_id != null ? Number(p.catalog_image_id) : null,
      sortOrder: idx,
      complements: [...(groupsByProduct.get(p.id)?.values() ?? [])],
    };
  });

  return { enabled, items };
}

function hashSnapshot(snapshot: PublicMenuSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

let currentPublish: Promise<boolean> | null = null;

/**
 * Publica o menu agora, se ele mudou. `force` ignora o hash (usado quando o QR é aberto,
 * para garantir que o cliente veja o cardápio deste instante).
 * Retorna `true` quando o Cloud confirmou a publicação.
 *
 * Chamadas concorrentes (scheduler de 45s + abertura do QR) compartilham a MESMA
 * publicação em vez de a segunda receber `false` e o lojista ver "não foi possível
 * publicar" sem motivo.
 */
export async function publishMenuNow(force = false): Promise<boolean> {
  if (currentPublish) return currentPublish;
  currentPublish = doPublish(force);
  try {
    return await currentPublish;
  } finally {
    currentPublish = null;
  }
}

async function doPublish(force: boolean): Promise<boolean> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return false;

  const lic = validateLicense();
  const enabled = lic.status === 'valida'
    && canUseQrOrder(lic.plan)
    && hasCapability('comandas.pedido_qr');
  const previousHash = settingsRepository.get(SETTING_HASH);

  // Nunca publicou e o recurso está desligado: não há o que tirar do ar — e nem motivo
  // para varrer o catálogo a cada 45s em toda empresa que não usa o QR.
  if (!force && !previousHash && !enabled) return false;

  const snapshot: PublicMenuSnapshot = enabled
    ? buildSnapshot(true)
    : { enabled: false, items: [] };
  const hash = hashSnapshot(snapshot);
  if (!force && previousHash === hash) return true;

  try {
    const r = await fetch(`${base}/api/menu/publish`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...snapshot, hash }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      log.warn(`publicação recusada (HTTP ${r.status}): ${body.error ?? 'sem detalhe'}`);
      return false;
    }
    settingsRepository.set(SETTING_HASH, hash);
    settingsRepository.set(SETTING_PUBLISHED_AT, new Date().toISOString());
    return true;
  } catch (e) {
    // Sem rede: mantém o hash antigo para tentar de novo no próximo ciclo.
    log.warn('não foi possível publicar o menu público:', (e as Error).message);
    return false;
  }
}

let debounce: NodeJS.Timeout | null = null;

/** Agenda uma publicação curta depois de uma mudança no catálogo/complementos. */
export function scheduleMenuPublish(delayMs = 4000): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void publishMenuNow();
  }, Math.max(0, delayMs));
  debounce.unref?.();
}

let timer: NodeJS.Timeout | null = null;

/** Rede de segurança: qualquer mudança que escapou dos gatilhos sai em até 45s. */
export function startMenuPublisherScheduler(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void publishMenuNow(), PUBLISH_INTERVAL_MS);
  timer.unref?.();
  // No boot, publica se o recurso está ligado (ou desliga a página se foi desativado
  // enquanto o app estava fechado).
  scheduleMenuPublish(1500);
}

/** Última publicação bem-sucedida (a tela do QR usa para mostrar a idade do menu). */
export function lastMenuPublishAt(): string | null {
  return settingsRepository.get(SETTING_PUBLISHED_AT);
}
