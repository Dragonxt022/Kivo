import { migrateUp, migrateDown, migrationStatus } from './migrator';
import { closeDb } from './connection';
import { resetTestData } from './resetData';

const cmd = process.argv[2];

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
  default:
    console.log('Uso: cli.ts <up|down|status|reset>');
}
closeDb();
