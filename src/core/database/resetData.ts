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
  'product_image_submissions',
]);

/**
 * Reset de fábrica (o botão da zona de perigo, em Configurações → Avançado). Mesmo alvo do
 * reset de teste, com quatro diferenças que só importam quando quem aperta é o lojista com
 * o app rodando, e não um dev pelo CLI:
 *
 *  - `capabilities` sobrevive. As linhas são o catálogo de recursos, recriado por
 *    `registerCapabilities()` só no boot dos módulos: esvaziar a tabela com o processo no ar
 *    deixaria todo `requireCapability` sem referência até alguém reiniciar o Kivo.
 *  - `backups` sobrevive, com os arquivos. É a única forma de desfazer um reset feito por
 *    engano — e o reset tira um backup automático antes de começar, justamente para isso.
 *  - `sessions` sobrevive na linha de quem está resetando (ver `factoryReset`), senão o
 *    lojista é deslogado no meio da operação e não chega a ver o assistente reabrir.
 *  - `settings` é limpo por chave, e não preservado inteiro (ver SETTINGS_KEEP_PREFIXES).
 */
const KEEP_INTACT_FABRICA = new Set([...KEEP_INTACT, 'capabilities', 'backups', 'sessions']);

/**
 * O que sobra de `settings` num reset de fábrica. Tudo o que não casar com um destes
 * prefixos volta ao padrão de instalação (a ausência da linha é o próprio padrão).
 *
 * `onboarding.` fica FORA de propósito: apagar `onboarding.completed` é o que faz o
 * assistente de boas-vindas reabrir sozinho no próximo carregamento, que é o objetivo
 * inteiro do botão — o lojista sai do teste e é levado de volta ao começo.
 */
const SETTINGS_KEEP_PREFIXES = [
  // Dados da empresa (nome, razão social, CNPJ, IE, contato, endereço, logo). O assistente
  // reaberto usa o nome como valor inicial do campo, em vez de pedir tudo de novo.
  'empresa.',
  // Endereço do servidor de sincronização: perdê-lo desconectaria a máquina da nuvem, e
  // recuperar exige digitar a URL à mão em Configurações → Avançado.
  'sync.server_url',
  // Segredo de recuperação de senha. Sem ele o lojista pode ficar trancado para fora.
  'recovery.',
  // Agendamento e pasta do backup local — configuração desta máquina, não dado de teste.
  'backup.',
  // Marcadores de backfill já aplicados pelas seeds; apagá-los faria as seeds refazerem
  // trabalho concluído no próximo boot.
  'seeds.',
];

function settingsKeyIsPreserved(key: string): boolean {
  return SETTINGS_KEEP_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p));
}

export interface ResetSummary {
  table: string;
  removed: number;
}

interface ResetOptions {
  /** Tabelas intocadas. */
  keep: Set<string>;
  /** Sessão que não pode cair junto (token de quem está resetando). */
  keepSessionToken?: string;
  /**
   * Usuário que não pode ser apagado, além dos administradores.
   *
   * Existe porque o reset é liberado pela PERMISSÃO `settings.edit`, e não pelo cargo:
   * um cargo personalizado (um "gerente" com essa permissão) passa pela rota, cairia no
   * `DELETE ... WHERE role_id NOT IN (administrador)` e sairia da operação com a própria
   * conta apagada e a sessão apontando para um usuário inexistente — trancado para fora
   * do sistema que acabou de zerar.
   */
  keepUserId?: number;
  /** Limpa `settings` por chave em vez de preservar a tabela inteira. */
  pruneSettings?: boolean;
}

function runReset(opts: ResetOptions): ResetSummary[] {
  const db = getSqlite();
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'`)
      .all() as { name: string }[]
  ).map((r) => r.name);

  const summary: ResetSummary[] = [];
  const push = (table: string, removed: number) => {
    if (removed) summary.push({ table, removed });
  };

  // FK só pode ser alternado fora de uma transação (mesma regra do migrator.ts).
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const table of tables) {
        if (opts.keep.has(table)) continue;
        if (table === 'users') {
          push(
            table,
            db
              .prepare(
                `DELETE FROM users
                  WHERE role_id NOT IN (SELECT id FROM roles WHERE slug = 'administrador')
                    AND id IS NOT ?`,
              )
              // `IS NOT` em vez de `!=`: com keepUserId nulo, `id != NULL` é NULL (nunca
              // verdadeiro) e a cláusula engoliria o DELETE inteiro, não apagando ninguém.
              .run(opts.keepUserId ?? null).changes,
          );
          continue;
        }
        // Preserva as categorias-sistema do DRE (Receita Bruta/CMV/Taxas de cartão etc.,
        // semeadas uma única vez pela migration 0033_dre_base) — sem elas o relatório de
        // DRE fica mudo mesmo com vendas reais, porque não sobra onde agrupar as linhas
        // automáticas. Só categorias manuais criadas pelo usuário são consideradas teste.
        if (table === 'dre_categories') {
          push(table, db.prepare(`DELETE FROM dre_categories WHERE system = 0`).run().changes);
          continue;
        }
        push(table, db.prepare(`DELETE FROM "${table}"`).run().changes);
      }

      if (opts.pruneSettings) {
        const keys = (db.prepare(`SELECT key FROM settings`).all() as { key: string }[]).map((r) => r.key);
        const doomed = keys.filter((k) => !settingsKeyIsPreserved(k));
        const del = db.prepare(`DELETE FROM settings WHERE key = ?`);
        let removed = 0;
        for (const k of doomed) removed += del.run(k).changes;
        push('settings', removed);
      }

      if (opts.keepSessionToken) {
        push('sessions', db.prepare(`DELETE FROM sessions WHERE token != ?`).run(opts.keepSessionToken).changes);
      }
    })();
  } finally {
    // No finally: um erro no meio não pode deixar o banco com FK desligada para o resto
    // da vida do processo — a próxima escrita passaria sem checagem nenhuma.
    db.pragma('foreign_keys = ON');
  }
  return summary;
}

/**
 * Zera os dados de teste do banco local: apaga todo o histórico de negócio
 * (produtos, clientes, fornecedores, vendas, compras, orçamentos, contas,
 * caixa, auditoria, sessões etc.) e remove todo usuário que não tenha o cargo
 * "administrador". Preserva a biblioteca de imagens (product_image_submissions)
 * e os arquivos físicos em storage/product-images/. Não roda migrations nem
 * seeds — só limpa linhas existentes.
 */
export function resetTestData(): ResetSummary[] {
  return runReset({ keep: KEEP_INTACT });
}

/**
 * Reset de fábrica pedido pelo lojista. Diferenças em relação ao de cima em
 * KEEP_INTACT_FABRICA e SETTINGS_KEEP_PREFIXES.
 *
 * Não fala com a nuvem nem tira backup: quem orquestra isso (e aborta se a nuvem falhar)
 * é `core/reset/service.ts`, porque a ordem entre as duas pontas é o que decide se o
 * reset dura ou se o próximo sync traz tudo de volta.
 */
export function resetToFactory(keepSessionToken?: string, keepUserId?: number): ResetSummary[] {
  return runReset({ keep: KEEP_INTACT_FABRICA, keepSessionToken, keepUserId, pruneSettings: true });
}
