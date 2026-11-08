import { getSqlite } from '../database/connection';

/**
 * Avisos de "pedido pronto" para quem está FORA da tela da cozinha/mesas.
 *
 * O painel da cozinha e a grade de mesas já avisam enquanto estão abertos. O problema é
 * quem está no PDV, no financeiro ou em outra página: o ticket vira "pronto" e ninguém
 * fica sabendo até voltar para a tela certa. Este serviço lê os tickets prontos direto do
 * banco (o módulo de foodservice pode até estar desligado — aí a tabela nem existe) para
 * alimentar o canal global incluído no cabeçalho de todas as páginas.
 */

export interface ReadyAlert {
  /** id do kitchen_ticket. É a chave de deduplicação por aparelho. */
  id: number;
  sourceType: 'sale' | 'comanda';
  sourceId: number;
  /** "Mesa 01" ou "Pedido #123" — texto pronto para o aviso. */
  label: string;
  /** `entrega`/`viagem` para o garçom saber que é sacola, não mesa. */
  serviceType: 'local' | 'viagem' | 'entrega';
  /** Momento em que o ticket ficou pronto (updated_at do SQLite, UTC). */
  readyAt: string | null;
}

let tableChecked = false;
let tableExists = false;

/** A tabela só existe quando o módulo de cozinha já rodou as migrations nesta instalação. */
function kitchenTableExists(): boolean {
  if (tableChecked) return tableExists;
  tableChecked = true;
  try {
    tableExists = !!getSqlite()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kitchen_tickets'")
      .get();
  } catch {
    tableExists = false;
  }
  return tableExists;
}

function labelFor(sourceType: string, sourceId: number, tableLabel: string | null, serviceType: string): string {
  const prefix = serviceType === 'entrega' ? 'Entrega — ' : serviceType === 'viagem' ? 'Viagem — ' : '';
  if (sourceType === 'comanda') {
    return prefix + (tableLabel && tableLabel.trim() ? tableLabel.trim() : `Comanda #${sourceId}`);
  }
  // Venda direta do PDV: o table_label gravado é "PDV", que não ajuda a identificar o
  // pedido. O número da venda é mais útil para quem vai entregar.
  return prefix + `Pedido #${sourceId}`;
}

function toAlert(row: {
  id: number;
  source_type: string;
  source_id: number;
  table_label: string | null;
  service_type: string;
  updated_at: string | null;
}): ReadyAlert {
  const sourceType = row.source_type === 'comanda' ? 'comanda' : 'sale';
  const serviceType = row.service_type === 'entrega'
    ? 'entrega'
    : row.service_type === 'viagem' ? 'viagem' : 'local';
  return {
    id: Number(row.id),
    sourceType,
    sourceId: Number(row.source_id),
    label: labelFor(sourceType, Number(row.source_id), row.table_label, serviceType),
    serviceType,
    readyAt: row.updated_at ?? null,
  };
}

/** Tickets que estão prontos AGORA (ainda não entregues), do mais recente para o mais antigo. */
export function listReadyAlerts(limit = 30): ReadyAlert[] {
  if (!kitchenTableExists()) return [];
  const rows = getSqlite()
    .prepare(
      `SELECT id, source_type, source_id, table_label, service_type, updated_at
         FROM kitchen_tickets
        WHERE deleted_at IS NULL AND status = 'pronto'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.trunc(limit)))) as {
    id: number;
    source_type: string;
    source_id: number;
    table_label: string | null;
    service_type: string;
    updated_at: string | null;
  }[];
  return rows.map(toAlert);
}

/** Um ticket específico, se ele estiver pronto neste instante. */
export function findReadyAlert(ticketId: number): ReadyAlert | null {
  if (!kitchenTableExists() || !Number.isInteger(ticketId) || ticketId <= 0) return null;
  const row = getSqlite()
    .prepare(
      `SELECT id, source_type, source_id, table_label, service_type, updated_at
         FROM kitchen_tickets
        WHERE id = ? AND deleted_at IS NULL AND status = 'pronto'`,
    )
    .get(ticketId) as
    | {
      id: number;
      source_type: string;
      source_id: number;
      table_label: string | null;
      service_type: string;
      updated_at: string | null;
    }
    | undefined;
  return row ? toAlert(row) : null;
}
