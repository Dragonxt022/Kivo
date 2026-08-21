/**
 * Test utilities — unwraps the { success, data } response envelope
 * so tests can read properties directly.
 */

/**
 * Corpo JSON de resposta num teste, quando declarar a forma exata não paga o custo:
 * a asserção logo abaixo já é a verificação, e tipar cada payload de rota duplicaria o
 * schema num lugar que ninguém mantém.
 *
 * Existe para ser o ÚNICO `any` dos testes. Preferir `unwrap<ApiRow>(...)` a
 * `unwrap<any>(...)` mantém a exceção visível num ponto só — e revisável — em vez de
 * espalhada por dezenas de arquivos. Para uma resposta cuja forma importa, declare a
 * interface de verdade em vez de usar este alias.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ver o bloco acima
export type ApiRow = Record<string, any>;

export async function unwrap<T>(r: Response): Promise<T> {
  const body: unknown = await r.json();
  if (body && typeof body === 'object' && 'success' in body) {
    const env = body as { success: boolean; data?: T; error?: string };
    if (env.success) return env.data as T;
    throw new Error(env.error ?? 'API error');
  }
  return body as T;
}
