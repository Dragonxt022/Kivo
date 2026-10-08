import { randomUUID } from 'node:crypto';
import { machineId } from '../../core/license/service';
import { customerRepository } from './repositories/CustomerRepository';
import type { Row } from '../../core/database/repository';

/**
 * Acesso a `customers` como SERVIÇO, para outros módulos criarem/lerem cliente sem importar
 * repositório alheio (o Core proíbe import direto entre módulos).
 *
 * Existe por causa do módulo odonto: um paciente é SEMPRE um cliente (`customers`) mais uma
 * ficha clínica, porque é para `customers` que `receivables.customer_id` aponta — sem isso a
 * cobrança do tratamento, o convênio e a lista de preço do paciente não teriam onde se apoiar.
 */

export interface CustomerInput {
  name: string;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  cep?: string | null;
  notes?: string | null;
  birthday?: string | null;
  /** Foto de identificação (`/uploads/customers/…`). Una por cliente; o Odonto lê daqui. */
  photo_file?: string | null;
}

/** Atualização parcial: só as chaves presentes são gravadas. */
export type CustomerPatch = Partial<CustomerInput>;

/** Campos que o serviço aceita atualizar (evita sobrescrever saldo/pontos/convênio). */
const UPDATABLE = ['name', 'document', 'email', 'phone', 'address', 'cep', 'notes', 'birthday', 'photo_file'] as const;

function pickUpdatable(input: CustomerPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of UPDATABLE) {
    if (input[f] !== undefined) data[f] = input[f];
  }
  return data;
}

/** Cria o cliente e devolve o id. Sempre com `uuid`/`origin_machine` (contrato de sync). */
export function createCustomer(input: CustomerInput): number {
  return customerRepository.create({
    ...pickUpdatable(input),
    name: input.name,
    uuid: randomUUID(),
    origin_machine: machineId(),
  });
}

/** Atualiza só os campos cadastrais; saldos e convênio ficam com quem os mantém. */
export function updateCustomer(id: number, input: CustomerPatch): void {
  const data = pickUpdatable(input);
  if (!Object.keys(data).length) return;
  customerRepository.update(id, data);
}

export function findCustomerById(id: number): Row | undefined {
  return customerRepository.rawOne('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', id);
}

/** CPF/CNPJ já cadastrado — compara só os dígitos, como o CRUD do commercial. */
export function findCustomerByDocument(document: unknown): { id: number; name: string } | undefined {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (!digits) return undefined;
  return customerRepository.rawOne(
    `SELECT id, name FROM customers
      WHERE deleted_at IS NULL
        AND REPLACE(REPLACE(REPLACE(REPLACE(document, '.', ''), '-', ''), '/', ''), ' ', '') = ?
      LIMIT 1`,
    digits,
  ) as { id: number; name: string } | undefined;
}
