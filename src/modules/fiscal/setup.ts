import { registerService } from '../../core/services/registry';
import { fiscalDocumentRepository } from './repositories/FiscalDocumentRepository';

/**
 * Serviço consumido por outros módulos — hoje só o `store`, para saber se uma venda tem
 * documento fiscal de pé antes de deixar cancelá-la.
 *
 * O `store` nunca importa o módulo fiscal: ele chama `hasService('fiscal.documents')` e
 * segue normal se o serviço não existir (mesmo padrão do hook da cozinha em `sales.ts`).
 * Assim uma instalação sem o módulo fiscal continua funcionando sem nenhuma condicional
 * espalhada pelo PDV.
 */
export interface FiscalDocumentsService {
  /** Existe nota pendente, autorizada ou em contingência para esta venda? */
  hasLiveDocument(saleId: number): boolean;
}

export default function setup(): void {
  const documents: FiscalDocumentsService = {
    hasLiveDocument: (saleId) => fiscalDocumentRepository.hasLiveDocument(saleId),
  };
  registerService('fiscal.documents', documents);
}
