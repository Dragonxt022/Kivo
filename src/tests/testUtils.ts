/**
 * Test utilities — unwraps the { success, data } response envelope
 * so tests can read properties directly.
 */
export async function unwrap<T>(r: Response): Promise<T> {
  const body: unknown = await r.json();
  if (body && typeof body === 'object' && 'success' in body) {
    const env = body as { success: boolean; data?: T; error?: string };
    if (env.success) return env.data as T;
    throw new Error(env.error ?? 'API error');
  }
  return body as T;
}
