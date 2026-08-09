import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getSqlite } from './connection';
import { ROLE_PRESETS } from '../roles/presets';

/** Permissões do Core. Módulos adicionam as suas via manifesto. */
export const CORE_PERMISSIONS: { key: string; description: string }[] = [
  { key: 'users.view', description: 'Visualizar usuários' },
  { key: 'users.create', description: 'Criar usuários' },
  { key: 'users.edit', description: 'Editar usuários' },
  { key: 'users.delete', description: 'Excluir usuários' },
  { key: 'roles.view', description: 'Visualizar cargos e permissões' },
  { key: 'roles.edit', description: 'Editar cargos e permissões' },
  { key: 'audit.view', description: 'Visualizar log de auditoria' },
  { key: 'settings.view', description: 'Visualizar configurações' },
  { key: 'settings.edit', description: 'Editar configurações' },
  { key: 'settings.capabilities.edit', description: 'Gerenciar recursos (capabilities) dos módulos' },
  { key: 'backup.view', description: 'Visualizar histórico de backups' },
  { key: 'backup.run', description: 'Executar backup manual' },
  { key: 'backup.restore', description: 'Restaurar backup' },
  { key: 'backup.delete', description: 'Excluir backup (local e, se enviado, na nuvem)' },
  { key: 'license.view', description: 'Visualizar licença' },
  { key: 'license.edit', description: 'Alterar licença' },
  { key: 'sync.run', description: 'Executar sincronização manual com a nuvem' },
  { key: 'billing.view', description: 'Visualizar cobranças da nuvem' },
  { key: 'security.pin.manage', description: 'Definir/alterar o PIN de administrador' },
];

/**
 * Marca de que o preenchimento retroativo (abaixo) já rodou. Instalações anteriores à
 * versão 1.0.1 criaram Caixa/Estoquista/Entregador sem permissão nenhuma — sem esta
 * flag elas ficariam para sempre com os cargos inúteis, porque o `INSERT ... DO NOTHING`
 * do bloco de criação só age em cargo novo.
 */
const ROLE_BACKFILL_KEY = 'seeds.role_presets_backfill';

/** Idempotente: roda em todo boot sem duplicar nada. */
export function runSeeds(): void {
  const db = getSqlite();

  const insertPerm = db.prepare(
    `INSERT INTO permissions (key, description, module) VALUES (?, ?, 'core')
     ON CONFLICT(key) DO UPDATE SET description = excluded.description`,
  );
  for (const p of CORE_PERMISSIONS) insertPerm.run(p.key, p.description);

  const insertRole = db.prepare(
    `INSERT INTO roles (slug, name, is_system, uuid) VALUES (?, ?, 1, ?)
     ON CONFLICT(slug) DO NOTHING`,
  );
  const grant = db.prepare(
    `INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)
     ON CONFLICT(role_id, permission_key) DO NOTHING`,
  );

  /**
   * Preenchimento retroativo, uma única vez: os cargos de fábrica que já existem
   * recebem o modelo correspondente.
   *
   * É uma UNIÃO, nunca uma substituição — o `grant` é ON CONFLICT DO NOTHING e nada é
   * apagado. Por isso a passagem é segura mesmo em loja rodando há meses: o que o dono
   * acrescentou continua lá, e o Gerente (que nascia só com as permissões do Core, sem
   * conseguir vender nem ver estoque) ganha o resto sem perder nada.
   *
   * Depois desta passagem a flag é gravada e só cargo NOVO recebe modelo. É o que
   * garante que remover uma permissão do Caixa na tela seja definitivo, em vez de ela
   * voltar no próximo boot — que é o que aconteceria se as seeds regravassem sempre.
   */
  const backfillDone = db.prepare('SELECT value FROM settings WHERE key = ?').get(ROLE_BACKFILL_KEY) as
    | { value: string }
    | undefined;

  for (const role of ROLE_PRESETS) {
    const created = insertRole.run(role.slug, role.name, randomUUID()).changes === 1;
    const { id } = db.prepare('SELECT id FROM roles WHERE slug = ?').get(role.slug) as {
      id: number;
    };
    // Administrador é reconciliado sempre: `registerPermissions` (core/modules/loader.ts)
    // já lhe concede toda permissão nova de módulo a cada boot, então manter as do Core
    // em dia aqui é a mesma política, não uma reescrita do que o dono configurou — a
    // tela de cargos nem deixa editar esse cargo.
    if (role.permissions === '*') {
      for (const p of CORE_PERMISSIONS) grant.run(id, p.key);
      continue;
    }
    if (!created && backfillDone) continue;
    for (const key of role.permissions) grant.run(id, key);
  }

  if (!backfillDone) {
    db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, uuid, comment) VALUES (?, '1', ?, ?)`,
    ).run(
      ROLE_BACKFILL_KEY,
      randomUUID(),
      'Marca que os cargos de fábrica já receberam o conjunto de permissões padrão. Impede que as seeds regravem permissões que o administrador removeu de propósito.',
    );
  }

  const hasAdmin = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!hasAdmin) {
    const { id: roleId } = db
      .prepare("SELECT id FROM roles WHERE slug = 'administrador'")
      .get() as { id: number };
    db.prepare(
      `INSERT INTO users (username, name, password_hash, role_id, uuid) VALUES (?, ?, ?, ?, ?)`,
    ).run('admin', 'Administrador', bcrypt.hashSync('admin', 10), roleId, randomUUID());
    // Credencial de fábrica: ninguém precisa conhecê-la. Enquanto ela estiver intacta, a
    // home mostra a tela de primeiro acesso, onde o dono cria o próprio usuário e senha
    // (ver isFirstRunSetupPending em core/auth/service.ts).
    console.warn('[seeds] usuário inicial de fábrica criado (admin/admin) — a tela de primeiro acesso substitui essa credencial.');
  }

  // Configurações padrão do sistema — inseridas apenas se ainda não existirem,
  // preservando quaisquer alterações feitas pelo administrador.
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value, uuid, comment)
     VALUES (?, ?, ?, ?)`,
  ).run(
    'estoque.venda_estoque_zerado',
    '1',
    randomUUID(),
    'Permite realizar vendas mesmo quando o estoque do produto está zerado. "1" = permitir (padrão); "0" = bloquear.',
  );
}
