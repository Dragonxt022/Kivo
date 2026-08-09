import { randomUUID } from 'node:crypto';
import { getSqlite } from '../../core/database/connection';

/**
 * Cadastros que toda loja precisa ter no primeiro minuto de uso.
 *
 * Sem eles, duas telas nascem em beco sem saída: a venda a prazo/fiado exige escolher um
 * cliente e o combo vem vazio; o registro de compra exige um fornecedor e idem. O lojista
 * é obrigado a parar, sair da tela, cadastrar, e voltar — justo no momento em que está
 * testando o sistema pela primeira vez.
 *
 * A condição para criar é "a tabela está vazia", não uma flag de controle. Isso dá três
 * coisas de graça: é idempotente (roda em todo boot sem duplicar), sobrevive ao
 * `resetTestData()` (que limpa clientes/fornecedores mas preserva `settings`, então uma
 * flag ficaria marcada e o reset devolveria um banco sem os padrões), e não ressuscita o
 * registro em loja de verdade — quem apagou o "Cliente à vista" já tem outros clientes,
 * então a tabela não está vazia e nada é recriado.
 */
export function seedCommercialDefaults(): void {
  const db = getSqlite();

  const noCustomers = (db
    .prepare('SELECT COUNT(*) c FROM customers WHERE deleted_at IS NULL')
    .get() as { c: number }).c === 0;
  if (noCustomers) {
    db.prepare(
      `INSERT INTO customers (name, notes, uuid) VALUES (?, ?, ?)`,
    ).run(
      'Cliente à vista',
      'Cadastro padrão para a venda de balcão, quando o comprador não se identifica. Pode renomear ou excluir.',
      randomUUID(),
    );
  }

  const noSuppliers = (db
    .prepare('SELECT COUNT(*) c FROM suppliers WHERE deleted_at IS NULL')
    .get() as { c: number }).c === 0;
  if (noSuppliers) {
    db.prepare(
      `INSERT INTO suppliers (name, notes, uuid) VALUES (?, ?, ?)`,
    ).run(
      'Fornecedor Padrão',
      'Cadastro padrão para lançar uma compra sem ter o fornecedor cadastrado ainda. Pode renomear ou excluir.',
      randomUUID(),
    );
  }
}
