import { BaseRepository, type Row } from '../../../core/database/repository';

export class KitchenRoutingRepository extends BaseRepository {
  constructor() {
    super('kitchen_routing');
  }

  findAllActive(): Row[] {
    return this.raw(
      'SELECT product_id, station, estimated_minutes FROM kitchen_routing WHERE deleted_at IS NULL',
    );
  }
}

export const kitchenRoutingRepository = new KitchenRoutingRepository();

export class KitchenTicketRepository extends BaseRepository {
  constructor() {
    super('kitchen_tickets');
  }

  findByUuid(uuid: string): Row | undefined {
    return this.findOneWhere({ uuid } as unknown as Record<string, string | number | boolean | null>);
  }

  // Tie-break por id DESC: tickets criados no mesmo segundo tinham ordem instável
  // entre polls do KDS (cards "pulavam" de posição a cada refresh).
  listByStatus(statusFilter?: string[]): Row[] {
    if (statusFilter?.length) {
      const ph = statusFilter.map(() => '?').join(',');
      return this.raw(
        `SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL AND status IN (${ph}) ORDER BY updated_at DESC, id DESC`,
        ...statusFilter,
      );
    }
    return this.raw('SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC');
  }

  updateStatus(id: number, status: string): void {
    this.update(id, { status } as unknown as Partial<Row>);
  }

  /**
   * Quantos tickets 'pronto' (aguardando o garçom levar — a coluna "Prontos" do KDS)
   * cada comanda tem. A grade de mesas consome via serviço para marcar "pedido pronto".
   */
  readyCountByComanda(comandaIds: number[]): { comanda_id: number; ready_count: number }[] {
    if (!comandaIds.length) return [];
    const ph = comandaIds.map(() => '?').join(',');
    return this.raw(
      `SELECT source_id AS comanda_id, COUNT(*) AS ready_count
         FROM kitchen_tickets
        WHERE deleted_at IS NULL AND source_type = 'comanda'
          AND source_id IN (${ph}) AND status = 'pronto'
        GROUP BY source_id`,
      ...comandaIds,
    ) as { comanda_id: number; ready_count: number }[];
  }
}

export const kitchenTicketRepository = new KitchenTicketRepository();

export class KitchenTicketItemRepository extends BaseRepository {
  constructor() {
    super('kitchen_ticket_items');
  }

  listByTicket(ticketId: number): Row[] {
    return this.raw(
      'SELECT * FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY id',
      ticketId,
    );
  }

  /**
   * Quais itens de comanda JÁ foram enviados para a cozinha — "Enviar p/ cozinha" usa
   * isso para mandar só o que é novo (o garçom pode apertar várias vezes sem duplicar).
   */
  findSentComandaItemIds(comandaItemIds: number[]): number[] {
    if (!comandaItemIds.length) return [];
    const ph = comandaItemIds.map(() => '?').join(',');
    return (this.raw(
      `SELECT DISTINCT comanda_item_id FROM kitchen_ticket_items WHERE comanda_item_id IN (${ph}) AND deleted_at IS NULL`,
      ...comandaItemIds,
    ) as { comanda_item_id: number }[]).map((r) => r.comanda_item_id);
  }

  /** Itens de vários tickets numa query só — o painel mapeia N tickets sem N+1. */
  listByTickets(ticketIds: number[]): Row[] {
    if (!ticketIds.length) return [];
    const ph = ticketIds.map(() => '?').join(',');
    return this.raw(
      `SELECT * FROM kitchen_ticket_items WHERE ticket_id IN (${ph}) AND deleted_at IS NULL ORDER BY id`,
      ...ticketIds,
    );
  }

  /**
   * Propaga o status do ticket inteiro para os itens que ainda não terminaram
   * ('entregue' é ponto sem volta — itens já entregues não "voltam" se o status do
   * ticket for rebaixado manualmente).
   */
  advanceOpenItems(ticketId: number, status: string): void {
    this.rawRun(
      `UPDATE kitchen_ticket_items SET status = ?, updated_at = datetime('now')
       WHERE ticket_id = ? AND deleted_at IS NULL AND status != 'entregue'`,
      status, ticketId,
    );
  }

  findInTicket(itemId: number, ticketId: number): Row | undefined {
    return this.rawOne(
      'SELECT id, status FROM kitchen_ticket_items WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL',
      itemId, ticketId,
    );
  }

  distinctStatusesByTicket(ticketId: number): Row[] {
    return this.raw(
      'SELECT DISTINCT status FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL',
      ticketId,
    );
  }

  updateItemStatus(id: number, status: string): void {
    this.update(id, { status } as unknown as Partial<Row>);
  }
}

export const kitchenTicketItemRepository = new KitchenTicketItemRepository();
