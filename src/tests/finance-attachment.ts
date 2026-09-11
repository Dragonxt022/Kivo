/**
 * Teste do anexo de documento em contas a pagar (migration 0066 + rotas).
 * Cobre: upload, aparecer na lista, download com o nome original, remover e
 * rejeição de tipo não permitido.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3497);
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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
const b64 = (b: Buffer) => b.toString('base64');

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const F = '/api/finance';

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  const pay = await api(`${F}/payables`, { method: 'POST', body: JSON.stringify({ description: 'Boleto do mês', amountCents: 12345, dueDate: '2026-10-10' }) }, admin!);
  check('conta a pagar criada', pay.status === 201);
  const id = (await unwrap<{ id: number }>(pay)).id;

  // ---- Upload ----
  const up = await api(`${F}/payables/${id}/attachment`, { method: 'POST', body: JSON.stringify({ file: b64(PDF), name: 'boleto-outubro.pdf' }) }, admin!);
  check('upload do anexo', up.status === 200);
  const upBody = await unwrap<{ attachment_name: string; attachment_size: number; attachment_mime: string }>(up);
  check('nome original preservado', upBody.attachment_name === 'boleto-outubro.pdf', upBody.attachment_name);
  check('mime do PDF', upBody.attachment_mime === 'application/pdf', upBody.attachment_mime);
  check('tamanho registrado', upBody.attachment_size === PDF.length, String(upBody.attachment_size));

  // ---- Aparece na lista ----
  const list = await unwrap<{ id: number; attachment_name: string | null }[]>(await api(`${F}/payables`, {}, admin!));
  const row = list.find((b) => b.id === id);
  check('lista traz o anexo', !!row && row.attachment_name === 'boleto-outubro.pdf');

  // ---- Download ----
  const dl = await api(`${F}/payables/${id}/attachment`, {}, admin!);
  check('download 200', dl.status === 200);
  const cd = dl.headers.get('content-disposition') ?? '';
  check('content-disposition com o nome', cd.includes('boleto-outubro.pdf'), cd);
  const got = Buffer.from(await dl.arrayBuffer());
  check('bytes do download batem', got.equals(PDF), `${got.length} bytes`);

  // ---- Tipo não permitido ----
  const bad = await api(`${F}/payables/${id}/attachment`, { method: 'POST', body: JSON.stringify({ file: b64(Buffer.from('x')), name: 'script.html' }) }, admin!);
  check('html recusado (400)', bad.status === 400);

  // ---- Remover ----
  const del = await api(`${F}/payables/${id}/attachment`, { method: 'DELETE' }, admin!);
  check('remove anexo', del.status === 200);
  const after = await unwrap<{ attachment_name: string | null }>(del);
  check('anexo removido da conta', after.attachment_name === null);
  const dl404 = await api(`${F}/payables/${id}/attachment`, {}, admin!);
  check('download sem anexo → 404', dl404.status === 404);

  server.close();
  console.log(failures === 0 ? '\nAnexo de contas: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
