/** Contrato de sincronização declarado por cada módulo no seu manifesto (KIVO_PLANO.md §6). */

/** Tabela filha (line item): sincroniza embutida no payload do agregado pai, sem uuid próprio. */
export interface SyncChildSpec {
  table: string;
  parentColumn: string;
  /** coluna do filho -> nome da tabela sincronizável referenciada (traduzida para uuid no payload). */
  foreignKeys?: Record<string, string>;
  /** colunas que referenciam tabelas não-sincronizáveis (ex.: payment_methods, per-máquina) — nunca viajam. */
  excludeColumns?: string[];
}

/** Ledger append-only (ex.: stock_movements): nunca editado, sem updated_at/deleted_at. */
export interface SyncLedgerSpec {
  parentTable: string;
  parentColumn: string;
  foreignKeys?: Record<string, string>;
}

export interface SyncTableSpec {
  table: string;
  /** coluna -> nome da tabela sincronizável referenciada (id local traduzido para uuid no payload). */
  foreignKeys?: Record<string, string>;
  /** colunas derivadas que nunca viajam na rede (ex.: stock_qty, balance_after). */
  excludeColumns?: string[];
  children?: SyncChildSpec[];
  /** presente quando esta tabela é um ledger append-only vinculado a um pai. */
  ledgerFor?: SyncLedgerSpec;
}

export interface RegisteredSyncTable extends SyncTableSpec {
  entityType: string;
  moduleId: string;
}

export interface OutgoingRecord {
  entityType: string;
  uuid: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
  originMachine: string;
}

export interface IncomingRecord {
  entityType: string;
  uuid: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
  originMachine: string;
}
