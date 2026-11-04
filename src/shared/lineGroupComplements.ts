/**
 * Anexa os complementos ao item principal de cada `lineGroupUuid`.
 *
 * O carrinho/comanda guarda o principal e cada adicional como linhas separadas. A cozinha
 * recebe um ticket por produto roteado; sem isto, o Açaí chegava sozinho e a Granola/Leite
 * (que não são roteados) desapareciam. O primeiro item do grupo é o principal; os demais
 * viram texto no campo `complements` dele.
 *
 * A lista de entrada deve estar na ordem de criação (ORDER BY id / ordem do carrinho):
 * é o que define qual item é o principal. Se o principal não estiver na lista (já enviado
 * antes), o grupo não é anexado a ninguém — evita mostrar "complementos" num adicional
 * que chegou sozinho depois.
 */
export function attachComplements<T extends { lineGroupUuid?: string | null; qty: number }>(
  items: T[],
  label: (item: T) => string,
): (T & { complements?: string[] })[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (!item.lineGroupUuid) continue;
    const group = groups.get(item.lineGroupUuid);
    if (group) group.push(item);
    else groups.set(item.lineGroupUuid, [item]);
  }

  return items.map((item) => {
    if (!item.lineGroupUuid) return item;
    const group = groups.get(item.lineGroupUuid);
    if (!group || group[0] !== item) return item;
    const complements = group.slice(1).map((extra) => {
      const qty = Number(extra.qty);
      const prefix = Number.isFinite(qty) && qty !== 1 ? `${qty}x ` : '';
      return `${prefix}${label(extra)}`;
    });
    return complements.length ? { ...item, complements } : item;
  });
}
