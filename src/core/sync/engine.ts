import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { machineId, refreshLicenseFromCloud, validateLicense } from '../license/service';
import { canSaveToCloud } from '../license/plans';
import { getSyncTables, getRecomputeHook } from './registry';
import {
  tableColumns,
  getUuidById,
  getIdByUuid,
  getRowByUuid,
  getRowById,
  foreignKeyTargets,
  anyExistingId,
} from './introspect';
import { pushBatch, pullBatch } from './client';
import type {
  RegisteredSyncTable,
  SyncChildSpec,
  OutgoingRecord,
  IncomingRecord,
} from './types';

const BATCH_SIZE = 200;
const ALWAYS_SKIP = new Set(['id', 'uuid', 'synced_at', 'origin_machine', 'updated_at', 'deleted_at', 'comment']);

class UnresolvedForeignKeyError extends Error {}

function db() {
  return getSqlite();
}

function nowIso(): string {
  return (db().prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
}

function isLedger(spec: RegisteredSyncTable): boolean {
  return !!spec.ledgerFor;
}

/** Colunas FK efetivas: as declaradas + a coluna de vínculo com o pai, se for ledger. */
function effectiveForeignKeys(spec: RegisteredSyncTable): Record<string, string> {
  const fk = { ...(spec.foreignKeys ?? {}) };
  if (spec.ledgerFor) {
    fk[spec.ledgerFor.parentColumn] = spec.ledgerFor.parentTable;
    Object.assign(fk, spec.ledgerFor.foreignKeys ?? {});
  }
  return fk;
}

// ---------------------------------------------------------------------------
// Coletar linhas alteradas (push)
// ---------------------------------------------------------------------------

const DIRTY_BATCH_SIZE = 500;

function collectDirtyRows(spec: RegisteredSyncTable): Record<string, unknown>[] {
  if (isLedger(spec)) {
    return db().prepare(`SELECT * FROM ${spec.table} WHERE synced_at IS NULL LIMIT ?`).all(DIRTY_BATCH_SIZE) as Record<
      string,
      unknown
    >[];
  }
  return db()
    .prepare(`SELECT * FROM ${spec.table} WHERE synced_at IS NULL OR synced_at < updated_at LIMIT ?`)
    .all(DIRTY_BATCH_SIZE) as Record<string, unknown>[];
}

function buildChildPayload(child: SyncChildSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of tableColumns(child.table).map((c) => c.name)) {
    if (col === 'id' || col === child.parentColumn || ALWAYS_SKIP.has(col)) continue;
    if (child.excludeColumns?.includes(col)) continue;
    out[col] = child.foreignKeys?.[col]
      ? getUuidById(child.foreignKeys[col], row[col] as number | null)
      : row[col];
  }
  return out;
}

function buildOutgoingPayload(spec: RegisteredSyncTable, row: Record<string, unknown>): Record<string, unknown> {
  const fk = effectiveForeignKeys(spec);
  const payload: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table).map((c) => c.name)) {
    if (ALWAYS_SKIP.has(col) || spec.excludeColumns?.includes(col)) continue;
    payload[col] = fk[col] ? getUuidById(fk[col], row[col] as number | null) : row[col];
  }
  for (const child of spec.children ?? []) {
    const rows = db()
      .prepare(`SELECT * FROM ${child.table} WHERE ${child.parentColumn} = ?`)
      .all(row.id) as Record<string, unknown>[];
    payload[child.table] = rows.map((r) => buildChildPayload(child, r));
  }
  return payload;
}

/** Reúne todas as linhas "sujas" de todas as tabelas registradas, prontas para push. */
export function collectOutgoingBatch(): OutgoingRecord[] {
  const machine = machineId();
  const out: OutgoingRecord[] = [];
  for (const spec of getSyncTables()) {
    for (const row of collectDirtyRows(spec)) {
      out.push({
        entityType: spec.entityType,
        uuid: String(row.uuid),
        payload: buildOutgoingPayload(spec, row),
        updatedAt: String(row.updated_at ?? row.created_at),
        deletedAt: row.deleted_at != null ? String(row.deleted_at) : null,
        originMachine: machine,
      });
    }
  }
  return out;
}

function markSynced(records: OutgoingRecord[]): void {
  const byTable = new Map<string, string[]>();
  for (const spec of getSyncTables()) {
    const uuids = records.filter((r) => r.entityType === spec.entityType).map((r) => r.uuid);
    if (uuids.length) byTable.set(spec.table, uuids);
  }
  const ts = nowIso();
  for (const [table, uuids] of byTable) {
    const placeholders = uuids.map(() => '?').join(', ');
    db().prepare(`UPDATE ${table} SET synced_at = ? WHERE uuid IN (${placeholders})`).run(ts, ...uuids);
  }
}

// ---------------------------------------------------------------------------
// Aplicar linhas recebidas (pull)
// ---------------------------------------------------------------------------

/** Traduz o payload recebido em valores de coluna locais; lança se uma FK ainda não existe localmente. */
function payloadToRowValues(spec: RegisteredSyncTable, payload: Record<string, unknown>): Record<string, unknown> {
  const fk = effectiveForeignKeys(spec);
  const values: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table).map((c) => c.name)) {
    if (ALWAYS_SKIP.has(col) || spec.excludeColumns?.includes(col)) continue;
    if (fk[col]) {
      const uuidValue = payload[col] as string | null;
      const localId = getIdByUuid(fk[col], uuidValue);
      if (uuidValue != null && localId == null) {
        throw new UnresolvedForeignKeyError(`FK não resolvida: ${spec.table}.${col} -> ${fk[col]}(${uuidValue})`);
      }
      values[col] = localId;
    } else {
      values[col] = payload[col] ?? null;
    }
  }
  return values;
}

function applyChildren(spec: RegisteredSyncTable, parentLocalId: number, payload: Record<string, unknown>): void {
  for (const child of spec.children ?? []) {
    const rows = (payload[child.table] as Record<string, unknown>[] | undefined) ?? [];
    db().prepare(`DELETE FROM ${child.table} WHERE ${child.parentColumn} = ?`).run(parentLocalId);
    if (!rows.length) continue;
    const cols = tableColumns(child.table)
      .map((c) => c.name)
      .filter((n) => n !== 'id' && n !== child.parentColumn && n !== 'comment' && !child.excludeColumns?.includes(n));
    const insertCols = [child.parentColumn, ...cols];
    const stmt = db().prepare(
      `INSERT INTO ${child.table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`,
    );
    for (const r of rows) {
      const values = cols.map((c) => {
        if (!child.foreignKeys?.[c]) return c === 'uuid' ? (r[c] as string) ?? randomUUID() : r[c] ?? null;
        const uuidValue = r[c] as string | null;
        const localId = getIdByUuid(child.foreignKeys[c], uuidValue);
        if (uuidValue != null && localId == null) {
          throw new UnresolvedForeignKeyError(
            `FK não resolvida (filho): ${child.table}.${c} -> ${child.foreignKeys[c]}(${uuidValue})`,
          );
        }
        return localId;
      });
      stmt.run(parentLocalId, ...values);
    }
  }
}

/**
 * Colunas derivadas (excludeColumns) ficam de fora do payload — mas se forem NOT NULL
 * sem DEFAULT no schema (ex.: stock_movements.balance_after), o INSERT precisa de um
 * placeholder. É seguro: o hook de recompute (ex.: recomputeStockForProducts) corrige
 * o valor real logo em seguida, antes de qualquer leitura.
 */
function placeholdersForExcluded(spec: RegisteredSyncTable): Record<string, unknown> {
  const fkTargets = foreignKeyTargets(spec.table);
  const values: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table)) {
    if (!spec.excludeColumns?.includes(col.name) || !col.notNull || col.hasDefault) continue;
    const refTable = fkTargets.get(col.name);
    // FK real para tabela não sincronizada (ex.: users): usa qualquer id local existente
    // (toda instalação tem ao menos o admin seedado). Sem FK (ex.: balance_after): usa 0.
    values[col.name] = refTable ? anyExistingId(refTable) : 0;
  }
  return values;
}

function insertNewRow(spec: RegisteredSyncTable, rec: IncomingRecord): number {
  const values = { ...placeholdersForExcluded(spec), ...payloadToRowValues(spec, rec.payload) };
  const cols = Object.keys(values);
  const isLedgerTable = isLedger(spec);
  const controlCols = isLedgerTable ? ['uuid', 'synced_at', 'origin_machine'] : ['uuid', 'updated_at', 'deleted_at', 'synced_at', 'origin_machine'];
  const allCols = [...cols, ...controlCols];
  const info = db()
    .prepare(`INSERT INTO ${spec.table} (${allCols.join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})`)
    .run(
      ...cols.map((c) => values[c]),
      rec.uuid,
      ...(isLedgerTable ? [] : [rec.updatedAt, rec.deletedAt]),
      nowIso(),
      rec.originMachine,
    );
  const localId = Number(info.lastInsertRowid);
  if (!isLedgerTable) applyChildren(spec, localId, rec.payload);
  return localId;
}

function updateRow(req: Request, spec: RegisteredSyncTable, local: Record<string, unknown>, rec: IncomingRecord): void {
  const localId = Number(local.id);
  const localUpdatedAt = String(local.updated_at);
  const localSyncedAt = local.synced_at != null ? String(local.synced_at) : null;
  const localWasDirty = localSyncedAt === null || localUpdatedAt > localSyncedAt;
  // Edição concorrente: o último autor local difere de quem escreveu o valor que está chegando.
  // Complementa `localWasDirty` — sozinho, `synced_at` não sobrevive a rodadas de sync já
  // confirmadas antes de o conflito real aparecer (a própria máquina já marcou seu push como
  // sincronizado antes de saber da edição concorrente de outra máquina).
  const localOrigin = local.origin_machine != null ? String(local.origin_machine) : null;
  const differentAuthor = localOrigin != null && localOrigin !== rec.originMachine;

  const incomingWins =
    rec.updatedAt > localUpdatedAt ||
    (rec.updatedAt === localUpdatedAt && rec.originMachine > String(local.origin_machine ?? ''));
  if (!incomingWins) return; // local vence; será enviado no próximo push

  if (localWasDirty || differentAuthor) {
    audit(req, 'sync.conflict', spec.table, localId, local, rec.payload);
  }
  const values = payloadToRowValues(spec, rec.payload);
  const cols = Object.keys(values);
  const sets = cols
    .map((c) => `${c} = ?`)
    .concat(['updated_at = ?', 'deleted_at = ?', 'synced_at = ?', 'origin_machine = ?'])
    .join(', ');
  db()
    .prepare(`UPDATE ${spec.table} SET ${sets} WHERE id = ?`)
    .run(...cols.map((c) => values[c]), rec.updatedAt, rec.deletedAt, nowIso(), rec.originMachine, localId);
  applyChildren(spec, localId, rec.payload);
}

type PendingRecompute = Map<string, Set<number>>;

function applyIncomingRecord(req: Request, spec: RegisteredSyncTable, rec: IncomingRecord, pending: PendingRecompute): number | null {
  if (isLedger(spec)) {
    const existing = getRowByUuid(spec.table, rec.uuid);
    if (existing) return null; // append-only: já aplicado
    const localId = insertNewRow(spec, rec);
    const hook = getRecomputeHook(spec.table);
    if (hook) {
      const inserted = getRowById(spec.table, localId)!;
      const parentLocalId = Number(inserted[spec.ledgerFor!.parentColumn]);
      if (!pending.has(spec.table)) pending.set(spec.table, new Set());
      pending.get(spec.table)!.add(parentLocalId);
    }
    return localId;
  }
  const local = getRowByUuid(spec.table, rec.uuid);
  if (!local) return insertNewRow(spec, rec);
  updateRow(req, spec, local, rec);
  return Number(local.id);
}

async function applyIncomingBatch(req: Request, records: IncomingRecord[]): Promise<void> {
  const byEntityType = new Map(getSyncTables().map((s) => [s.entityType, s]));
  const pending: PendingRecompute = new Map();
  let queue = records;
  const lastError = new Map<string, string>();
  for (let attempt = 0; attempt < 3 && queue.length; attempt++) {
    const next: IncomingRecord[] = [];
    for (const rec of queue) {
      const spec = byEntityType.get(rec.entityType);
      if (!spec) continue;
      try {
        applyIncomingRecord(req, spec, rec, pending);
      } catch (e) {
        if (e instanceof UnresolvedForeignKeyError) {
          next.push(rec);
          lastError.set(rec.uuid, e.message);
        } else {
          throw e;
        }
      }
    }
    queue = next;
  }
  for (const rec of queue) {
    audit(req, 'sync.unresolved_fk', rec.entityType, undefined, null, {
      uuid: rec.uuid,
      reason: lastError.get(rec.uuid),
    });
  }
  for (const [table, ids] of pending) {
    const hook = getRecomputeHook(table);
    if (hook) await hook([...ids]);
  }
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

async function pushAll(): Promise<number> {
  const outgoing = collectOutgoingBatch();
  let count = 0;
  for (let i = 0; i < outgoing.length; i += BATCH_SIZE) {
    const batch = outgoing.slice(i, i + BATCH_SIZE);
    await pushBatch(machineId(), batch);
    markSynced(batch);
    count += batch.length;
  }
  return count;
}

async function pullAll(req: Request): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await pullBatch(cursor);
    await applyIncomingBatch(req, page.records);
    count += page.records.length;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}

export async function runSync(req: Request): Promise<{ pushed: number; pulled: number; skipped?: boolean }> {
  // Reconectar também confirma entitlement/validade (Fase 6b) — best-effort, não
  // interrompe o resto do sync se o cloud/ estiver fora do ar. Módulos são checados
  // dinamicamente por requisição (não só no boot), então o plano atualizado aqui já
  // reflete imediatamente no restante do app.
  await refreshLicenseFromCloud();
  if (!canSaveToCloud(validateLicense().plan)) {
    return { pushed: 0, pulled: 0, skipped: true };
  }
  const pushed = await pushAll();
  const pulled = await pullAll(req);
  return { pushed, pulled };
}
