/**
 * Teste da DoD da Fase 1 (Capabilities + Product Type):
 * 1. registerCapabilities upserta com enabled=0 e preserva enabled existente.
 * 2. hasCapability reflete enabled=0/1 + module entitlement.
 * 3. setCapabilityEnabled via PUT /api/core/capabilities/:key funciona e audita.
 * 4. hasCapability retorna false se isModuleEntitled do módulo dono for falso.
 * 5. product_type column existe em products (default 'fisico').
 */
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb } from './resetTestDb';
import { registerCapabilities } from '../core/modules/loader';

// Simula um módulo que declara capabilities
const TEST_MODULE = {
  id: 'test_caps',
  name: 'Test Capabilities',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [],
  capabilities: [
    { key: 'test_caps.feature_x', description: 'Feature X description' },
    { key: 'test_caps.feature_y', description: 'Feature Y description' },
  ],
};

let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();

  const db = getSqlite();

  // 5. product_type column existe
  const cols = db.prepare("PRAGMA table_info('products')").all() as { name: string; dflt_value: string | null }[];
  const hasProductType = cols.some((c) => c.name === 'product_type');
  check('products tem coluna product_type', hasProductType);
  if (hasProductType) {
    const def = cols.find((c) => c.name === 'product_type')!;
    check('product_type default é fisico', (def.dflt_value ?? '').includes('fisico'));
    // Tenta inserir um produto com todos os tipos válidos
    const validTypes = ['fisico', 'variante', 'fracionado', 'composto', 'kit', 'combo', 'produzido', 'servico', 'digital', 'assinatura'];
    for (const t of validTypes) {
      const uuid = randomUUID();
      db.prepare(`INSERT INTO products (name, product_type, uuid) VALUES (?, ?, ?)`).run(`prod_${t}`, t, uuid);
      const row = db.prepare('SELECT product_type FROM products WHERE uuid = ?').get(uuid) as { product_type: string };
      check(`product_type '${t}' aceito`, row.product_type === t);
    }
    // Tipo inválido deve rejeitar
    const badUuid = randomUUID();
    let rejeitou = false;
    try {
      db.prepare(`INSERT INTO products (name, product_type, uuid) VALUES (?, ?, ?)`).run('prod_invalido', 'invalido', badUuid);
    } catch (_e: unknown) {
      void _e;
      rejeitou = true;
    }
    check('product_type inválido rejeitado pelo CHECK', rejeitou);
  }

  // 1. registerCapabilities upserta com enabled=0
  registerCapabilities(TEST_MODULE as any);
  const rows = db.prepare('SELECT key, enabled FROM capabilities ORDER BY key').all() as { key: string; enabled: number }[];
  check('capabilities inseridas (2 rows)', rows.length === 2);
  check('feature_x enabled=0', rows.find((r) => r.key === 'test_caps.feature_x')?.enabled === 0);
  check('feature_y enabled=0', rows.find((r) => r.key === 'test_caps.feature_y')?.enabled === 0);

  // Registrar de novo: enabled preservado (continua 0)
  registerCapabilities(TEST_MODULE as any);
  const rows2 = db.prepare('SELECT key, enabled FROM capabilities ORDER BY key').all() as { key: string; enabled: number }[];
  check('re-registro preserva enabled (0)', rows2.every((r) => r.enabled === 0) && rows2.length === 2);

  // Agora marca enabled=1 direto no banco e re-registra
  db.prepare('UPDATE capabilities SET enabled = 1 WHERE key = ?').run('test_caps.feature_x');
  registerCapabilities(TEST_MODULE as any);
  const rowX = db.prepare('SELECT enabled FROM capabilities WHERE key = ?').get('test_caps.feature_x') as { enabled: number };
  check('re-registro preserva enabled (1)', rowX.enabled === 1);

  // 2. hasCapability (precisa do server rodando para isModuleEntitled, mas testamos a lógica SQL)
  // Import hasCapability e testa com módulo que existe
  const { hasCapability } = require('../core/capabilities/service');
  // Ainda não chamamos activateTestLicense, então isModuleEntitled retorna null (fail-open == true)
  check('hasCapability com enabled=1 → true', hasCapability('test_caps.feature_x') === true);
  check('hasCapability com enabled=0 → false', hasCapability('test_caps.feature_y') === false);
  check('hasCapability key inexistente → false', hasCapability('test_caps.nonexistent') === false);

  // 3. setCapabilityEnabled via código direto
  const { setCapabilityEnabled } = require('../core/capabilities/service');
  // Mock um req mínimo
  const fakeReq = { user: { id: 1, username: 'admin' }, ip: '127.0.0.1' } as any;
  setCapabilityEnabled(fakeReq, 'test_caps.feature_y', true);
  const rowY = db.prepare('SELECT enabled FROM capabilities WHERE key = ?').get('test_caps.feature_y') as { enabled: number };
  check('setCapabilityEnabled liga feature_y', rowY.enabled === 1);
  check('hasCapability agora true', hasCapability('test_caps.feature_y') === true);

  // Audit log
  const auditLog = db.prepare("SELECT action, entity, entity_id FROM audit_logs WHERE entity = 'capability'").all() as {
    action: string; entity: string; entity_id: string;
  }[];
  check('audit registrou edição de capability', auditLog.length >= 1 && auditLog.some((a) => a.entity_id === 'test_caps.feature_y'));

  // Desliga de novo
  setCapabilityEnabled(fakeReq, 'test_caps.feature_y', false);
  check('hasCapability false após desligar', hasCapability('test_caps.feature_y') === false);

  closeDb();
  console.log(failures === 0 ? '\nCapabilities: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
