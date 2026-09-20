import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getSqlite } from './connection';
import { ROLE_PRESETS } from '../roles/presets';
import { createLogger } from '../logger';

const log = createLogger('seeds');

/** Permissões do Core. Módulos adicionam as suas via manifesto. */
export const CORE_PERMISSIONS: { key: string; description: string }[] = [
  { key: 'users.view', description: 'Visualizar usuários' },
  { key: 'users.create', description: 'Criar usuários' },
  { key: 'users.edit', description: 'Editar usuários' },
  { key: 'users.delete', description: 'Excluir usuários' },
  { key: 'users.remote.manage', description: 'Conceder e revogar acesso pelo celular (Kivo Web)' },
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
    log.warn('usuário inicial de fábrica criado (admin/admin) — a tela de primeiro acesso substitui essa credencial.');
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

  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value, uuid, comment)
     VALUES (?, ?, ?, ?)`,
  ).run(
    'sync.intervalo_minutos',
    '3',
    randomUUID(),
    'Intervalo em minutos do ciclo automático de sincronização com a nuvem. "0" desliga (só sincroniza no clique manual). É o que mantém atual o acompanhamento pelo celular (Kivo Web).',
  );

  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value, uuid, comment)
     VALUES (?, ?, ?, ?)`,
  ).run(
    'telemetria.habilitada',
    '1',
    randomUUID(),
    'Envia erros anônimos e inventário de hardware (OS, CPU, RAM, GPU, tela e versões) para o suporte melhorar o sistema. Só dado técnico, sem dado pessoal. "1" = ligado (padrão); "0" = desligado.',
  );

  // Preferências do PDV — todas com padrão "comportamento de hoje", para a atualização não
  // mudar a operação de quem já usa o caixa.
  const pdvSettings: [string, string, string][] = [
    ['pdv.som', '1', 'Toca um sinal sonoro no PDV ao adicionar item ou concluir a venda. "1" = ligado (padrão); "0" = desligado.'],
    ['pdv.imprimir_automatico', '0', 'Imprime o cupom automaticamente ao finalizar a venda, sem perguntar. "1" = automático; "0" = perguntar (padrão).'],
    ['pdv.desconto_maximo_percentual', '0', 'Desconto máximo (%) que o operador aplica sem autorização por PIN. "0" = sem limite (padrão).'],
    ['pdv.desconto_exige_motivo', '0', 'Exige um motivo ao aplicar desconto/acréscimo no PDV. "1" = exigir; "0" = opcional (padrão).'],
    ['pdv.parcelas_max', '12', 'Número máximo de parcelas na venda a prazo do PDV. Padrão 12.'],
  ];
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value, uuid, comment) VALUES (?, ?, ?, ?)`,
  );
  for (const [key, value, comment] of pdvSettings) insertSetting.run(key, value, randomUUID(), comment);

  // Padrões do cadastro de produtos. Ficam explícitos aqui (e não só no código) para a
  // tela de Configurações mostrar a escolha real e o cadastro preencher igual.
  insertSetting.run(
    'estoque.auto_sku',
    '0',
    randomUUID(),
    'Gera automaticamente um SKU ao cadastrar produto sem código. "1" = gerar; "0" = deixar o campo em branco (padrão).',
  );
  insertSetting.run(
    'estoque.min_stock_padrao',
    '5',
    randomUUID(),
    'Valor de estoque mínimo sugerido ao cadastrar um produto novo. Padrão 5.',
  );

  // Rótulo do módulo de comandas: a loja que atende só no balcão vê "Balcão" (e outro
  // ícone) no lugar de "Mesas". O assistente grava conforme a resposta; aqui fica o padrão.
  insertSetting.run(
    'comandas.rotulo',
    'mesa',
    randomUUID(),
    'Como a empresa chama o módulo de comandas: "mesa" ou "balcao". Muda o rótulo e o ícone no menu e na tela inicial.',
  );

  // Cor de destaque da empresa. Fica na tabela `settings` (e não no localStorage) para
  // valer em qualquer aparelho que abra este Kivo pela rede local.
  insertSetting.run(
    'interface.cor_destaque',
    'orange',
    randomUUID(),
    'Cor de destaque da empresa: blue, green, orange, pink, black ou custom. Vale em todos os aparelhos que abrem este Kivo.',
  );
  insertSetting.run(
    'interface.cor_custom',
    '#ff8000',
    randomUUID(),
    'Cor de destaque personalizada (hex) usada quando interface.cor_destaque = "custom".',
  );

  // Sincronização automática ligada por padrão a cada 3 minutos. A semente acima já cobre
  // instalações novas; este resgate único devolve o padrão a instalações antigas que
  // ficaram com "0" (desligado). A flag impede que a semente reative o sync em todo boot —
  // se o dono desligar de propósito depois, a escolha é respeitada.
  const SYNC_DEFAULT_KEY = 'seeds.sync_intervalo_padrao_3';
  const syncDefaultDone = db.prepare('SELECT value FROM settings WHERE key = ?').get(SYNC_DEFAULT_KEY);
  if (!syncDefaultDone) {
    const atual = db
      .prepare("SELECT value FROM settings WHERE key = 'sync.intervalo_minutos' AND deleted_at IS NULL")
      .get() as { value: string | null } | undefined;
    if (!atual || atual.value == null || atual.value === '' || atual.value === '0') {
      db.prepare(
        `INSERT INTO settings (key, value, uuid, comment) VALUES (?, '3', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = '3', updated_at = datetime('now'), deleted_at = NULL`,
      ).run(
        'sync.intervalo_minutos',
        randomUUID(),
        'Intervalo em minutos do ciclo automático de sincronização com a nuvem. "0" desliga (só sincroniza no clique manual). É o que mantém atual o acompanhamento pelo celular (Kivo Web).',
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, uuid, comment) VALUES (?, '1', ?, ?)`,
    ).run(
      SYNC_DEFAULT_KEY,
      randomUUID(),
      'Marca que o intervalo de sincronização já foi ajustado para o padrão de 3 minutos. Impede que as seeds reativem o sync que o administrador desligou de propósito.',
    );
  }

  // Pacote de ícones (tema visual) da empresa. Vazio = conjunto padrão do Kivo. Os arquivos
  // ficam em storage/peck-icon/<pacote>/; a resolução é por requisição em core/icons/service.ts.
  insertSetting.run(
    'interface.pacote_icones',
    '',
    randomUUID(),
    'Pacote de ícones (tema visual) aplicado em todo o sistema. Vazio = conjunto padrão do Kivo. Os pacotes ficam em storage/peck-icon/<pacote>/.',
  );
}
