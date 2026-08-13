import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { loadAuthUser } from '../auth/service';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';
import { validateLicense } from '../license/service';
import { canUseWebApp } from '../license/plans';

/**
 * Acesso ao Kivo Web (celular) por link/QR.
 *
 * O login remoto NÃO usa a senha do PDV: `users` não sincroniza, e o `password_hash` fica só
 * nesta máquina de propósito. Em vez disso, o admin gera aqui um token aleatório por usuário;
 * o link com esse token vale como credencial e é revogável num clique.
 *
 * Localmente guardamos apenas o sha256 — o valor em claro existe uma única vez, no retorno
 * desta função, para montar o QR na tela. Nem o banco local nem a nuvem conseguem recompor o
 * link depois disso.
 */

function db() {
  return getSqlite();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RemoteAccessRow {
  id: number;
  user_id: number;
  username: string;
  name: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function listRemoteAccess(userId?: number): RemoteAccessRow[] {
  const where = userId ? 'AND ra.user_id = ?' : '';
  const params = userId ? [userId] : [];
  return db()
    .prepare(
      `SELECT ra.id, ra.user_id, u.username, u.name, ra.label, ra.created_at, ra.last_used_at, ra.revoked_at
         FROM remote_access ra JOIN users u ON u.id = ra.user_id
        WHERE ra.deleted_at IS NULL ${where}
        ORDER BY ra.created_at DESC`,
    )
    .all(...params) as RemoteAccessRow[];
}

type GrantResult =
  | { ok: true; token: string; url: string }
  | { ok: false; error: string };

/**
 * `plano` e `nuvem configurada` são checados aqui, e não só na tela: sem isso um POST direto
 * criaria uma linha local que a nuvem nunca reconheceria — o lojista veria um QR que não
 * funciona, sem explicação.
 */
export async function grantRemoteAccess(req: Request, userId: number, label?: string): Promise<GrantResult> {
  const lic = validateLicense();
  if (!canUseWebApp(lic.plan)) {
    return { ok: false, error: 'O acesso pelo celular (Kivo Web) é exclusivo do plano Diamante.' };
  }
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    return { ok: false, error: 'Nuvem não configurada nesta instalação.' };
  }

  const user = db()
    .prepare('SELECT id, uuid, username, name FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL')
    .get(userId) as { id: number; uuid: string; username: string; name: string } | undefined;
  if (!user) return { ok: false, error: 'Usuário não encontrado ou inativo.' };

  const authUser = loadAuthUser(userId);
  if (!authUser) return { ok: false, error: 'Não foi possível carregar as permissões do usuário.' };

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  // A nuvem primeiro: se ela recusar (plano, rede), não sobra linha local prometendo um
  // acesso que não existe do outro lado.
  let cloudRes: Response;
  try {
    cloudRes = await fetch(`${base}/api/mobile/grants`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUuid: user.uuid,
        username: user.username,
        name: user.name,
        roleSlug: authUser.roleSlug,
        // Vai a lista pronta de permissões: a nuvem não precisa conhecer cargos nem replicar
        // role_permissions, e o celular fica limitado exatamente ao que a pessoa já podia.
        permissions: [...authUser.permissions],
        tokenHash,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, error: 'Sem conexão com a nuvem. Conecte-se e tente de novo.' };
  }
  if (!cloudRes.ok) {
    const body = (await cloudRes.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `A nuvem recusou a concessão (HTTP ${cloudRes.status}).` };
  }

  // Um acesso ativo por usuário: gerar de novo substitui o anterior (é o caminho de "perdi o
  // celular"), espelhando o ON DUPLICATE KEY UPDATE do lado da nuvem.
  db().prepare(
    `UPDATE remote_access SET revoked_at = datetime('now'), updated_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL AND deleted_at IS NULL`,
  ).run(userId);
  db().prepare(
    `INSERT INTO remote_access (user_id, token_hash, label, uuid) VALUES (?, ?, ?, ?)`,
  ).run(userId, tokenHash, label ?? null, randomUUID());

  audit(req, 'conceder_acesso_remoto', 'remote_access', userId, null, { username: user.username });
  // `/m/acesso/<token>` e não `/m/<token>`: sem o segmento fixo, o token colidiria com as
  // próprias rotas do painel (`/m/vendas` seria lido como um token chamado "vendas").
  return { ok: true, token, url: `${base}/m/acesso/${token}` };
}

export async function revokeRemoteAccess(req: Request, userId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = db().prepare('SELECT uuid, username FROM users WHERE id = ?').get(userId) as
    | { uuid: string; username: string }
    | undefined;
  if (!user) return { ok: false, error: 'Usuário não encontrado.' };

  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (base && auth) {
    try {
      await fetch(`${base}/api/mobile/grants/${user.uuid}`, {
        method: 'DELETE', headers: auth, signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Sem rede a revogação local ainda vale como registro, mas o celular continuaria
      // entrando — por isso o erro é reportado em vez de engolido.
      return { ok: false, error: 'Sem conexão com a nuvem: o acesso NÃO foi revogado. Tente de novo com internet.' };
    }
  }
  db().prepare(
    `UPDATE remote_access SET revoked_at = datetime('now'), updated_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL AND deleted_at IS NULL`,
  ).run(userId);
  audit(req, 'revogar_acesso_remoto', 'remote_access', userId, null, { username: user.username });
  return { ok: true };
}

/** Último uso vem da nuvem (é lá que o celular bate), para a lista do desktop não mentir. */
export async function fetchRemoteUsage(): Promise<Record<string, { last_used_at: string | null; revoked_at: string | null }>> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return {};
  try {
    const r = await fetch(`${base}/api/mobile/grants`, { headers: auth, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    const body = (await r.json()) as { grants?: { user_uuid: string; last_used_at: string | null; revoked_at: string | null }[] };
    return Object.fromEntries((body.grants ?? []).map((g) => [g.user_uuid, g]));
  } catch {
    return {};
  }
}
