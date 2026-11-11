/**
 * Compatibilidade de transição Kivo → Kuruk nos cabeçalhos HTTP.
 *
 * O cloud novo entende `X-Kuruk-*`; instalações antigas do cloud só entendem
 * `X-Kivo-*`. Durante a janela de atualização, o desktop envia os dois nomes —
 * o cloud novo ignora os duplicados e o antigo continua funcionando.
 *
 * Quando todas as instalações e o cloud estiverem na marca nova, este helper
 * pode ser removido junto com os headers legados.
 */
export function withLegacyBrandHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const [key, value] of Object.entries(headers)) {
    if (!/^x-kuruk-/i.test(key)) continue;
    const legacy = key.replace(/^x-kuruk-/i, 'x-kivo-');
    if (!(legacy in out)) out[legacy] = value;
  }
  return out;
}
