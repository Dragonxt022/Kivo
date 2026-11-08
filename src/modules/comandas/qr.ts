import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { hasCapability } from '../../core/capabilities/service';
import { canUseQrOrder } from '../../core/license/plans';
import { machineId, validateLicense } from '../../core/license/service';
import { cloudAuthHeaders, cloudBaseUrl } from '../../core/catalog/submissionQueue';
import { publishMenuNow } from '../../core/menu/publisher';
import { storeTableRepository } from './repositories/StoreTableRepository';

/**
 * QR de pedido por mesa.
 *
 * O token em claro é gerado aqui e guardado em `store_tables.qr_token` para a tela
 * reexibir o MESMO QR sem rotacionar. O Cloud guarda só o sha256 (`menu_table_tokens`).
 * Rotacionar invalida o QR impresso anteriormente; revogar tira a mesa do ar.
 */

export interface TableQr {
  url: string;
  qr: string;
  updatedAt: string | null;
}

export type TableQrResult = { ok: true; data: TableQr } | { ok: false; error: string };

interface TableRow {
  id: number;
  uuid: string;
  label: string;
  qr_token: string | null;
  qr_updated_at: string | null;
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function qrUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/pedido/${token}`;
}

async function renderQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { margin: 1, width: 260 });
}

/** Motivo pelo qual o recurso está desligado (a tela mostra quando o botão não aparece). */
export function qrOrderAvailability(): { available: boolean; reason: string | null } {
  const lic = validateLicense();
  if (!hasCapability('comandas.pedido_qr')) {
    return { available: false, reason: 'Ative o recurso "Pedido pela mesa via QR" em Configurações › Recursos.' };
  }
  if (!canUseQrOrder(lic.plan)) {
    return { available: false, reason: 'Pedido pela mesa via QR está disponível no plano Diamante ou durante o teste.' };
  }
  if (lic.status !== 'valida') {
    return { available: false, reason: 'A licença precisa estar válida para gerar o QR.' };
  }
  if (!cloudBaseUrl() || !cloudAuthHeaders()) {
    return { available: false, reason: 'Configure a nuvem para gerar o QR.' };
  }
  return { available: true, reason: null };
}

function findTable(tableId: number): TableRow | undefined {
  return storeTableRepository.rawOne(
    'SELECT id, uuid, label, qr_token, qr_updated_at FROM store_tables WHERE id = ? AND deleted_at IS NULL',
    tableId,
  ) as TableRow | undefined;
}

/** QR já gerado, sem tocar no Cloud (a modal reabre no mesmo QR). */
export async function getTableQr(tableId: number): Promise<TableQr | null> {
  const table = findTable(tableId);
  if (!table?.qr_token) return null;
  const base = cloudBaseUrl();
  if (!base) return null;
  const url = qrUrl(base, table.qr_token);
  return { url, qr: await renderQr(url), updatedAt: table.qr_updated_at };
}

export async function generateTableQr(req: Request, tableId: number, rotate = false): Promise<TableQrResult> {
  const availability = qrOrderAvailability();
  if (!availability.available) return { ok: false, error: availability.reason! };

  const table = findTable(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };

  if (table.qr_token && !rotate) {
    const cached = await getTableQr(tableId);
    if (cached) return { ok: true, data: cached };
  }

  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return { ok: false, error: 'Nuvem não configurada nesta instalação.' };

  // A página pública lê o menu publicado; publicar antes evita abrir um QR vazio/velho.
  const published = await publishMenuNow(true);
  if (!published) {
    return { ok: false, error: 'Não foi possível publicar o cardápio no Cloud. Verifique a conexão e tente de novo.' };
  }

  const token = randomBytes(32).toString('hex');
  let cloudRes: Response;
  try {
    cloudRes = await fetch(`${base}/api/menu/table-tokens`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableUuid: table.uuid,
        label: table.label,
        tokenHash: sha256(token),
        machineId: machineId(),
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return { ok: false, error: 'Sem conexão com a nuvem. Conecte-se e tente de novo.' };
  }
  if (!cloudRes.ok) {
    const body = (await cloudRes.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `A nuvem recusou o QR (HTTP ${cloudRes.status}).` };
  }

  storeTableRepository.rawRun(
    "UPDATE store_tables SET qr_token = ?, qr_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    token, tableId,
  );
  audit(req, rotate ? 'rotacionar_qr_mesa' : 'gerar_qr_mesa', 'table', tableId, null, { table: table.label });

  const url = qrUrl(base, token);
  return { ok: true, data: { url, qr: await renderQr(url), updatedAt: new Date().toISOString() } };
}

export async function revokeTableQr(req: Request, tableId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const table = findTable(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (!table.qr_token) return { ok: true };

  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (base && auth) {
    try {
      const r = await fetch(`${base}/api/menu/table-tokens/${encodeURIComponent(table.uuid)}`, {
        method: 'DELETE', headers: auth, signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? `A nuvem recusou a desativação (HTTP ${r.status}).` };
      }
    } catch {
      return { ok: false, error: 'Sem conexão com a nuvem: o QR NÃO foi desativado. Tente de novo com internet.' };
    }
  }

  storeTableRepository.rawRun(
    "UPDATE store_tables SET qr_token = NULL, qr_updated_at = NULL, updated_at = datetime('now') WHERE id = ?",
    tableId,
  );
  audit(req, 'desativar_qr_mesa', 'table', tableId, null, { table: table.label });
  return { ok: true };
}
