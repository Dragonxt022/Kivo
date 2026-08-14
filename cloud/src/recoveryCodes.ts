/**
 * Gêmeo de `src/core/recovery/codes.ts` (Kivo desktop) — ver lá a explicação do formato.
 *
 * São deploys separados, e a duplicação é a regra do projeto. A nuvem só precisa GERAR a
 * resposta que o suporte dita; quem verifica é o desktop. Os dois lados têm que produzir
 * exatamente o mesmo byte: mudou um, muda o outro.
 *
 * `src/tests/recuperacao-senha.ts` carrega ESTE arquivo e compara com o do desktop, e
 * ainda confere um vetor fixo:
 *
 *     expectedResponse('a'.repeat(64), 'A7K2-9QRM-3B4T-XZ01') === 'Y46T4-CTM60'
 *
 * O vetor é o que protege quem já está em campo: mudar o formato nos dois lados ao mesmo
 * tempo passaria na comparação e faria toda instalação instalada recusar o código do
 * suporte. Se precisar mesmo mudar, é versão nova no `DOMAIN`, não edição silenciosa.
 */
import { createHmac } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DOMAIN = 'kivo-resgate-v1|';
const RESPONSE_BYTES = 6;

function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function group(code: string, size: number): string {
  return (code.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join('-');
}

export function normalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function expectedResponse(secret: string, challenge: string): string {
  const mac = createHmac('sha256', secret).update(DOMAIN + normalize(challenge)).digest();
  return group(encodeBase32(mac.subarray(0, RESPONSE_BYTES)), 5);
}
