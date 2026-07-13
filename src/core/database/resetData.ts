import { getSqlite } from './connection';

/**
 * Configuração do sistema (não é "dado de teste"): RBAC, licença, PIN de
 * segurança, settings e formas de pagamento sobrevivem ao reset.
 */
const KEEP_INTACT = new Set([
  'roles',
  'role_permissions',
  'permissions',
  'modules',
  'license',
  'security_pin',
  'settings',
  'payment_methods',
]);

export interface ResetSummary {
  table: string;
  removed: number;
}

/**
 * Zera os dados de teste do banco local: apaga todo o histórico de negócio
 * (produtos, clientes, fornecedores, vendas, compras, orçamentos, contas,
 * caixa, auditoria, sessões etc.) e remove todo usuário que não tenha o cargo
 * "administrador". Não roda migrations nem seeds — só limpa linhas existentes.
 */
export function resetTestData(): ResetSummary[] {
  const db = getSqlite();
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'`)
      .all() as { name: string }[]
  ).map((r) => r.name);

  const summary: ResetSummary[] = [];
  // FK só pode ser alternado fora de uma transação (mesma regra do migrator.ts).
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    for (const table of tables) {
      if (KEEP_INTACT.has(table)) continue;
      if (table === 'users') {
        const { changes } = db
          .prepare(`DELETE FROM users WHERE role_id NOT IN (SELECT id FROM roles WHERE slug = 'administrador')`)
          .run();
        if (changes) summary.push({ table, removed: changes });
        continue;
      }
      // Preserva as categorias-sistema do DRE (Receita Bruta/CMV/Taxas de cartão etc.,
      // semeadas uma única vez pela migration 0033_dre_base) — sem elas o relatório de
      // DRE fica mudo mesmo com vendas reais, porque não sobra onde agrupar as linhas
      // automáticas. Só categorias manuais criadas pelo usuário são consideradas teste.
      if (table === 'dre_categories') {
        const { changes } = db.prepare(`DELETE FROM dre_categories WHERE system = 0`).run();
        if (changes) summary.push({ table, removed: changes });
        continue;
      }
      const { changes } = db.prepare(`DELETE FROM "${table}"`).run();
      if (changes) summary.push({ table, removed: changes });
    }
  })();
  db.pragma('foreign_keys = ON');
  return summary;
}
