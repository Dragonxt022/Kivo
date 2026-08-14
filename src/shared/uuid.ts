/**
 * UUID determinístico (estilo v5, RFC 4122) a partir de um nome.
 *
 * Para linhas "de fábrica" que o sync replica entre máquinas (ex.: categorias do DRE,
 * capabilities), a identidade PRECISA ser a mesma em toda instalação — senão cada
 * máquina gera um uuid diferente para o mesmo registro e o motor de sync (que casa por
 * uuid, não por chave natural) tenta inserir duplicado, estourando o UNIQUE da chave.
 *
 * Não é criptografia: é só uma forma estável de derivar o mesmo uuid do mesmo nome.
 * UUIDs gerados com randomUUID() continuam para tudo que é criado em UMA máquina.
 */
import { createHash } from 'node:crypto';

const NAMESPACE = 'kivo';

export function stableUuid(name: string): string {
  const hash = createHash('sha1').update(`${NAMESPACE}:${name}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versão 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}