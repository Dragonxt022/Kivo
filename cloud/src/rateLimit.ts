/**
 * Rate limit em memória, sem dependência externa.
 *
 * O `cloud/` é um deployable separado e enxuto (Express + MySQL), sem `express-rate-limit`.
 * Para frear endpoints públicos — tentativa de acesso pelo link do celular, formulário de
 * contato — um contador por IP na memória do processo basta. O mesmo padrão já existe em
 * `routes/landing.ts`; extraído aqui para o Kivo Web usar sem duplicar a lógica.
 *
 * Limitação assumida: com mais de um processo atrás do balanceador, cada um tem seu próprio
 * contador. Para um VPS único (o cenário atual) o efeito é o esperado.
 */
export interface RateLimiter {
  /** Registra a tentativa e devolve `true` quando o IP passou do limite. */
  (ip: string): boolean;
}

export function createRateLimiter(opts: { windowMs: number; max: number; keyPrefix?: string }): RateLimiter {
  const hits = new Map<string, number[]>();
  const prefix = opts.keyPrefix ?? '';

  return function limited(ip: string): boolean {
    const now = Date.now();
    const key = prefix + ip;
    const recentes = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (recentes.length >= opts.max) {
      hits.set(key, recentes);
      return true;
    }
    recentes.push(now);
    hits.set(key, recentes);
    // Poda: sem isso, IPs que nunca voltam ficariam na memória para sempre.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= opts.windowMs)) hits.delete(k);
      }
    }
    return false;
  };
}
