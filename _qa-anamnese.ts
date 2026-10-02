/**
 * Conferência visual da anamnese (arquivo temporário, fora de src/).
 * Sobe o app com banco descartável, cria paciente + duas revisões de anamnese e tira prints.
 */
import { migrateUp } from './src/core/database/migrator';
import { runSeeds } from './src/core/database/seeds';
import { createServer } from './src/core/server';
import { activateTestLicense, exitFirstRunState, resetTestDb } from './src/tests/resetTestDb';
import { chromium } from 'playwright';
import path from 'node:path';

const PORT = Number(process.env.QA_PORT ?? 4555);
const base = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(__dirname, '.qa-screenshots');

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  exitFirstRunState();
  const { app } = await createServer();
  const server = app.listen(PORT);

  const json = (rota: string, corpo: unknown, cookie?: string) => fetch(`${base}${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(corpo),
  });

  const login = await json('/api/auth/login', { username: 'admin', password: 'admin' });
  const cookie = `kivo_session=${(login.headers.get('set-cookie') || '').match(/kivo_session=([^;]+)/)![1]}`;

  /** As respostas da API vêm em `{ success, data }` (o app desembrulha no navegador). */
  const dados = async <T>(r: Response): Promise<T> => {
    const corpo = (await r.json()) as { data?: T } & T;
    return (corpo && typeof corpo === 'object' && 'data' in corpo ? corpo.data : corpo) as T;
  };

  const paciente = await json('/api/odonto/patients', {
    name: 'Marina Alves Ribeiro', document: '529.982.247-25', phone: '(69) 99911-2233',
    birthday: '1988-06-14', sex: 'feminino',
  }, cookie);
  const patientId = (await dados<{ id: number }>(paciente)).id;
  console.log('paciente criado: ' + patientId);

  await json(`/api/odonto/patients/${patientId}/anamnesis`, {
    answers: {
      queixa_principal: 'Sensibilidade no dente 26 quando toma água gelada, há duas semanas.',
      historico_medico: 'Hipertensão controlada com losartana. Sem cirurgias.',
      alergias: 'Dipirona e penicilina.',
      medicamentos: 'Losartana 50mg (manhã).',
      habitos: ['Bruxismo'],
      historico_odontologico: 'Restaurações nos dentes 16 e 26 em 2023. Nunca usou aparelho.',
      pressao_alta: 'sim',
      diabetes: 'nao',
      ultima_consulta: '2025-11-20',
      observacoes: 'Relata apertar os dentes durante o sono.',
    },
  }, cookie);

  await json(`/api/odonto/patients/${patientId}/anamnesis`, {
    answers: {
      queixa_principal: 'Sem sensibilidade hoje; iniciou placa de bruxismo há 1 mês.',
      historico_medico: 'Hipertensão controlada com losartana. Sem cirurgias.',
      alergias: 'Dipirona e penicilina.',
      medicamentos: 'Losartana 50mg (manhã).',
      habitos: ['Bruxismo', 'Roer unha'],
      historico_odontologico: 'Restaurações nos dentes 16 e 26 em 2023. Placa de bruxismo desde 09/2026.',
      pressao_alta: 'sim',
      diabetes: 'nao',
      ultima_consulta: '2026-09-15',
      observacoes: 'Orientada sobre placa e higiene.',
    },
  }, cookie);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') erros.push('console: ' + m.text()); });

  await page.goto(`${base}/?login=1`, { waitUntil: 'load' });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'admin');
  await Promise.all([
    page.waitForURL((u) => !u.search.includes('login'), { timeout: 20000 }),
    page.click('button[type="submit"], #login-submit'),
  ]);

  // Ficha do paciente com o resumo da anamnese.
  await page.goto(`${base}/app/odonto/pacientes/${patientId}`, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'odonto-ficha-anamnese.png'), fullPage: true });

  // Tela da anamnese: revisão atual + histórico.
  await page.goto(`${base}/app/odonto/pacientes/${patientId}/anamnese`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'odonto-anamnese.png'), fullPage: true });

  const revisoes = await page.locator('table tbody tr').count();
  const texto = await page.locator('main').innerText();

  // Nova revisão (pré-preenchida com a anterior).
  await page.getByRole('button', { name: /Nova revisão|Responder anamnese/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'odonto-anamnese-nova.png') });

  // Formulários (modelos) e nova versão.
  await page.goto(`${base}/app/odonto/anamnese-modelos`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'odonto-anamnese-modelos.png'), fullPage: true });

  console.log('linhas na tabela de histórico/revisões: ' + revisoes);
  console.log('mostra "revisão 2": ' + /revisão 2/i.test(texto));
  console.log('mostra a alergia: ' + /Dipirona/.test(texto));
  console.log('erros: ' + (erros.length ? erros.join(' | ') : 'nenhum'));

  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
