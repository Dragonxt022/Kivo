/**
 * Teste do módulo de clientes (segmentação e melhorias): unicidade de CPF/CNPJ,
 * data de nascimento/etiquetas, busca ampliada, filtros (situação, etiqueta,
 * aniversariantes), resumo da ficha, extrato de crédito/pontos, edição em massa,
 * paginação (X-Total-Count) e exportação CSV.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3788);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(u: string, p: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function main() {
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    const cust = await unwrap<{ id: number; birthday: string; tags: string }>(
      await api('/api/commercial/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Cliente Segmentado', document: '111.444.777-35', birthday: '1990-05-10', tags: 'VIP, atacado' }),
      }, admin!));
    check('birthday persiste', cust.birthday === '1990-05-10', cust.birthday);
    check('tags persiste', cust.tags === 'VIP, atacado', cust.tags);

    const dup = await api('/api/commercial/customers', {
      method: 'POST', body: JSON.stringify({ name: 'Cliente Duplicado', document: '11144477735' }),
    }, admin!);
    check('CPF/CNPJ duplicado → 409', dup.status === 409, String(dup.status));

    const badDate = await api('/api/commercial/customers', {
      method: 'POST', body: JSON.stringify({ name: 'Data Ruim', birthday: '10/05/1990' }),
    }, admin!);
    check('birthday inválido → 400', badDate.status === 400, String(badDate.status));

    const byDoc = await unwrap<{ id: number }[]>(await api('/api/commercial/customers?q=11144477735', {}, admin!));
    check('busca por dígitos do documento', byDoc.some((c) => c.id === cust.id), String(byDoc.length));

    const byTag = await unwrap<{ id: number }[]>(await api('/api/commercial/customers?tag=VIP', {}, admin!));
    check('filtro por etiqueta', byTag.length === 1 && byTag[0].id === cust.id, String(byTag.length));

    const byMonth = await unwrap<{ id: number }[]>(await api('/api/commercial/customers?birthdayMonth=5', {}, admin!));
    check('filtro aniversariantes do mês', byMonth.some((c) => c.id === cust.id), String(byMonth.length));

    const summary = await unwrap<{ purchases: unknown; monthly: unknown[] }>(
      await api(`/api/commercial/customers/${cust.id}/summary`, {}, admin!));
    check('summary retorna compras/mensal', 'purchases' in summary && Array.isArray(summary.monthly));

    const bulk = await api('/api/commercial/customers/bulk-update', {
      method: 'POST', body: JSON.stringify({ ids: [cust.id], patch: { active: false } }),
    }, admin!);
    check('bulk-update desativa → 200', bulk.status === 200, String(bulk.status));
    const actives = await unwrap<{ id: number }[]>(await api('/api/commercial/customers?active=1', {}, admin!));
    const inactives = await unwrap<{ id: number }[]>(await api('/api/commercial/customers?active=0', {}, admin!));
    check('cliente sai dos ativos', !actives.some((c) => c.id === cust.id));
    check('cliente aparece nos inativos', inactives.some((c) => c.id === cust.id));

    await api(`/api/commercial/customers/${cust.id}/credit`, {
      method: 'POST', body: JSON.stringify({ amountCents: 2500, reason: 'teste' }),
    }, admin!);
    const movements = await unwrap<{ type: string; amount: number }[]>(
      await api(`/api/commercial/customers/${cust.id}/credit-movements`, {}, admin!));
    check('extrato de crédito registra concessão', movements.length === 1 && movements[0].amount === 2500, String(movements.length));

    const loyalty = await api(`/api/commercial/customers/${cust.id}/loyalty-movements`, {}, admin!);
    check('extrato de pontos responde 200', loyalty.status === 200, String(loyalty.status));

    const paged = await api('/api/commercial/customers?limit=1', {}, admin!);
    check('paginação devolve X-Total-Count', Number(paged.headers.get('x-total-count')) >= 1, paged.headers.get('x-total-count') ?? '');
    const pagedRows = await unwrap<unknown[]>(paged);
    check('limit respeitado', pagedRows.length <= 1, String(pagedRows.length));

    const listCsv = await api('/api/commercial/customers/export.csv', {}, admin!);
    const listText = await listCsv.text();
    check('export lista CSV', listCsv.status === 200 && listText.includes('Cliente Segmentado'));
    const fichaCsv = await api(`/api/commercial/customers/${cust.id}/export.csv`, {}, admin!);
    const fichaText = await fichaCsv.text();
    check('export ficha CSV', fichaCsv.status === 200 && fichaText.includes('Extrato de crédito'));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0 ? '\nClientes (perfil): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
