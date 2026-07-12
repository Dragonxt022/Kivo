import { migrateUp, migrateDown, migrationStatus } from './migrator';
import { closeDb } from './connection';
import { resetTestData } from './resetData';
import { runSeeds } from './seeds';

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case 'up': {
      const done = migrateUp();
      console.log(done.length ? `Aplicadas: ${done.join(', ')}` : 'Nada a aplicar.');
      break;
    }
    case 'down': {
      const name = migrateDown();
      console.log(name ? `Revertida: ${name}` : 'Nada a reverter.');
      break;
    }
    case 'status': {
      for (const m of migrationStatus()) {
        console.log(`${m.applied ? '[x]' : '[ ]'} ${m.name}`);
      }
      break;
    }
    case 'reset': {
      const summary = resetTestData();
      if (!summary.length) {
        console.log('Nada para zerar — banco já estava limpo.');
        break;
      }
      console.log('Dados removidos (mantidos: cargos, permissões, licença, PIN, settings, formas de pagamento):');
      for (const s of summary) console.log(`  ${s.table}: ${s.removed}`);
      break;
    }
    case 'seed-demo': {
      const applied = migrateUp();
      if (applied.length) console.log(`[db] migrations aplicadas: ${applied.join(', ')}`);
      runSeeds();
      resetTestData();
      // import dinâmico: createServer/seedDemoData puxam todo o boot dos módulos
      // (Express, services) — só necessário para este comando, não para up/down/status/reset.
      const { createServer } = await import('../server');
      const { seedDemoData } = await import('./seedDemo');
      await createServer();
      console.log('[seed-demo] gerando ~30 dias de operação simulada...');
      const summary = seedDemoData();
      console.log('[seed-demo] concluído:');
      console.log(`  Período simulado: ${summary.days} dias`);
      console.log(`  Produtos: ${summary.products} | Clientes: ${summary.customers} | Fornecedores: ${summary.suppliers}`);
      console.log(`  Vendas: ${summary.sales} | Compras: ${summary.purchases} | Contas a pagar: ${summary.payables}`);
      console.log(`  Faturamento total: R$ ${(summary.revenueCents / 100).toFixed(2).replace('.', ',')}`);
      break;
    }
    default:
      console.log('Uso: cli.ts <up|down|status|reset|seed-demo>');
  }
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
