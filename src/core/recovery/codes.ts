/**
 * Formato dos códigos de resgate de senha — desafio e resposta.
 *
 * Estes códigos são DITADOS por telefone, então cada decisão aqui é sobre não errar a
 * transcrição: alfabeto Crockford base32 (sem I, L, O e U — some a confusão entre 1/I/L e
 * 0/O, e nenhum palavrão sai por acaso), tudo em maiúscula e agrupado de 4 em 4.
 *
 * A leitura é tolerante de propósito (`normalize`): quem ouviu "i" e digitou I, ou colou o
 * código com espaço no lugar do hífen, não pode receber "código inválido" por isso.
 *
 * ⚠ Este arquivo tem um GÊMEO em `cloud/src/recoveryCodes.ts`. São deploys separados (o
 * desktop verifica, a nuvem gera), e a duplicação é a regra do projeto — mas os dois
 * precisam produzir exatamente o mesmo byte. Mudou aqui, muda lá.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefixo do payload assinado: versiona o esquema e impede reuso do HMAC noutro contexto. */
const DOMAIN = 'kivo-resgate-v1|';

/** 10 bytes (80 bits) no desafio: colisão entre desafios abertos é impensável. */
const CHALLENGE_BYTES = 10;

/**
 * 6 bytes (48 bits) na resposta. Curto o bastante para ditar em 10 caracteres, e o que
 * segura a força bruta não é o tamanho e sim o limite de tentativas — 5 por desafio
 * (coluna `attempts`) mais o rate limit da rota.
 */
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
  // Sobra de bits vira um último caractere (preenchido com zeros à direita) — sem padding
  // `=`, que só atrapalharia na hora de ditar.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function group(code: string, size: number): string {
  return (code.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join('-');
}

/**
 * Deixa comparável o que a pessoa digitou: descarta tudo que não é letra/dígito e
 * reconcilia os caracteres que o alfabeto Crockford exclui justamente por serem
 * confundidos de ouvido (I/L → 1, O → 0, U → V).
 */
export function normalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/** Novo desafio, já formatado para leitura em voz alta (ex.: `A7K2-9QRM-3B4T-XZ01`). */
export function generateChallenge(): string {
  return group(encodeBase32(randomBytes(CHALLENGE_BYTES)), 4);
}

/**
 * Resposta esperada para um desafio, dado o segredo da instalação. É o mesmo cálculo dos
 * dois lados: a nuvem gera para o suporte ditar, o desktop recalcula para conferir.
 */
export function expectedResponse(secret: string, challenge: string): string {
  const mac = createHmac('sha256', secret).update(DOMAIN + normalize(challenge)).digest();
  return group(encodeBase32(mac.subarray(0, RESPONSE_BYTES)), 5);
}

/**
 * Confere a resposta digitada. Compara em tempo constante — o custo é zero e evita que o
 * tempo de resposta vaze quantos caracteres iniciais estavam certos.
 */
export function verifyResponse(secret: string, challenge: string, typed: string): boolean {
  const a = Buffer.from(normalize(expectedResponse(secret, challenge)));
  const b = Buffer.from(normalize(typed));
  return a.length === b.length && timingSafeEqual(a, b);
}
