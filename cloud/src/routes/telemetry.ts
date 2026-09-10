import { Router } from 'express';
import type { Response } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

/**
 * Telemetria do desktop: erros anônimos e inventário de hardware.
 *
 * Sem dado pessoal — só dado técnico, vinculado a (company_uuid, machine_id), que o
 * cloud já conhece via `company_devices`. O desktop agrega os erros por fingerprint
 * antes de enviar; aqui a gente acumula por (empresa, máquina, fingerprint).
 *
 * Autenticação: mesmas credenciais de licença do resto da API (X-Kivo-Company +
 * X-Kivo-License-Key) + X-Kivo-Machine-Id, como em /api/license/validate.
 */
const router = Router();
router.use(requireCompanyAuth);

/** Limite simples por empresa, em memória — mesmo espírito do throttle do /license/resolve. */
const HITS = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
function allow(companyUuid: string): boolean {
  const now = Date.now();
  const arr = (HITS.get(companyUuid) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    HITS.set(companyUuid, arr);
    return false;
  }
  arr.push(now);
  HITS.set(companyUuid, arr);
  return true;
}

function clip(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function asPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1_000_000) : fallback;
}

function jsonOrNull(v: unknown, max = 20_000): string | null {
  if (v == null) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

function machineOf(req: AuthedRequest): string {
  return clip(req.header('X-Kivo-Machine-Id'), 64) ?? '';
}

router.post('/errors', async (req: AuthedRequest, res: Response) => {
  const companyUuid = req.companyUuid!;
  if (!allow(companyUuid)) {
    res.status(429).json({ error: 'Muitos envios em pouco tempo — tente mais tarde.' });
    return;
  }
  const machine = machineOf(req);
  if (!machine) {
    res.status(400).json({ error: 'X-Kivo-Machine-Id ausente.' });
    return;
  }
  const list = Array.isArray(req.body?.errors) ? (req.body.errors as unknown[]).slice(0, 100) : [];
  if (!list.length) {
    res.json({ ok: true, stored: 0 });
    return;
  }

  const pool = getPool();
  let stored = 0;
  for (const raw of list) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const fingerprint = clip(e.fingerprint, 64);
    if (!fingerprint) continue;
    await pool.query(
      `INSERT INTO client_error_reports
         (company_uuid, machine_id, fingerprint, scope, level, message, stack, context, app_version, os, occurrences, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         occurrences = occurrences + VALUES(occurrences),
         message = VALUES(message), stack = VALUES(stack), context = VALUES(context),
         app_version = VALUES(app_version), os = VALUES(os),
         last_seen_at = GREATEST(COALESCE(last_seen_at, VALUES(last_seen_at)), VALUES(last_seen_at))`,
      [
        companyUuid,
        machine,
        fingerprint,
        clip(e.scope, 80),
        clip(e.level, 10) ?? 'error',
        clip(e.message, 4000),
        clip(e.stack, 20_000),
        jsonOrNull(e.context),
        clip(e.appVersion, 24),
        clip(e.os, 160),
        asPositiveInt(e.occurrences, 1),
        clip(e.firstSeenAt, 30),
        clip(e.lastSeenAt, 30),
      ],
    );
    stored++;
  }
  res.json({ ok: true, stored });
});

router.post('/machine', async (req: AuthedRequest, res: Response) => {
  const companyUuid = req.companyUuid!;
  if (!allow(companyUuid)) {
    res.status(429).json({ error: 'Muitos envios em pouco tempo — tente mais tarde.' });
    return;
  }
  const machine = machineOf(req);
  if (!machine) {
    res.status(400).json({ error: 'X-Kivo-Machine-Id ausente.' });
    return;
  }
  const data = jsonOrNull(req.body?.data);
  if (!data) {
    res.status(400).json({ error: 'Inventário ausente.' });
    return;
  }
  const ram = asPositiveInt(req.body?.ramGb, 0);
  await getPool().query(
    `INSERT INTO client_machine_inventory (company_uuid, machine_id, data, os, cpu, ram_gb, app_version)
     VALUES (?, ?, CAST(? AS JSON), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data), os = VALUES(os), cpu = VALUES(cpu), ram_gb = VALUES(ram_gb),
       app_version = VALUES(app_version), last_seen_at = CURRENT_TIMESTAMP(3)`,
    [companyUuid, machine, data, clip(req.body?.os, 160), clip(req.body?.cpu, 160), ram > 0 ? ram : null, clip(req.body?.appVersion, 24)],
  );
  res.json({ ok: true });
});

/** Apaga erro/inventário mais velho que a retenção (90 dias). Roda no boot e a cada 24h. */
export function startTelemetryRetention(): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    try {
      await getPool().query('DELETE FROM client_error_reports WHERE received_at < (NOW() - INTERVAL 90 DAY)');
    } catch (e) {
      console.error('[telemetry] falha na limpeza de erros antigos:', e);
    }
  };
  run();
  const timer = setInterval(run, 24 * 3600e3);
  timer.unref?.();
  return timer;
}

export default router;
