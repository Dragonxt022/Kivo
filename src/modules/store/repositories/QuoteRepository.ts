import { BaseRepository } from '../../../core/database/repository';

export class QuoteRepository extends BaseRepository {
  constructor() {
    super('quotes');
  }
}

export const quoteRepository = new QuoteRepository();
