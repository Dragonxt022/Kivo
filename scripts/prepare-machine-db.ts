/**
 * Prepara o banco de uma máquina de teste ANTES de `src/dev.ts` ser spawnado.
 *
 * Os testes multi-máquina (fase3b, fase6a–6d, fase7c, fase7d) sobem instâncias reais
 * de `src/dev.ts` com banco descartável próprio e fazem login de admin ANTES de
 * configurar a licença via `PUT /api/license`. O gate `requireActivation`
 * (core/server.ts) barra esse login com 403 `not_activated` — a ativação precisa
 * existir no banco antes do boot da máquina.
 *
 * Este script faz exatamente o que o `activateTestLicense()` faz nos testes
 * in-process, mas num processo separado (por isso é um script e não um helper
 * importado): `connection.ts` lê `KIVO_DB_PATH` no topo do módulo, então a variável
 * precisa estar no ambiente ANTES de qualquer `import` estático — que é hoisted.
 * Usamos `import()` dinâmico para garantir essa ordem.
 *
 * IMPORTANTE: ativação (activated_at) é propositalmente ORTOGONAL às credenciais
 * (company_uuid/license_key) — este script não configura licença nenhuma. Testes que
 * validam o comportamento "sem licença" (ex.: backup só local em fase6c, modo dev em
 * fase6b) dependem dessa separação.
 *
 * Uso: node scripts/prepare-machine-db.ts <caminho-do-db>
 */
process.env.KIVO_DB_PATH = process.argv[2];

async function main(): Promise<void> {
  const { migrateUp } = await import('../src/core/database/migrator');
  const { runSeeds } = await import('../src/core/database/seeds');
  const { activateTestLicense } = await import('../src/tests/resetTestDb');
  const { closeDb } = await import('../src/core/database/connection');
  const applied = migrateUp();
  if (applied.length) console.log(`[prepare-machine-db] migrations aplicadas: ${applied.join(', ')}`);
  runSeeds();
  activateTestLicense();
  closeDb();
}

main().catch((err) => {
  console.error('[prepare-machine-db]', err);
  process.exit(1);
});
