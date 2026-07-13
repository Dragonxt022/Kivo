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

  listByStatus(statusFilter?: string[]): Row[] {
    if (statusFilter?.length) {
      const ph = statusFilter.map(() => '?').join(',');
      return this.raw(
        `SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL AND status IN (${ph}) ORDER BY updated_at DESC`,
        ...statusFilter,
      );
    }
    return this.raw('SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC');
  }

  updateStatus(id: number, status: string): void {
    this.update(id, { status } as unknown as Partial<Row>);
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
