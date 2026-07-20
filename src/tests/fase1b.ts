/**
 * Teste da Fase 1b: configurações, backup local e licenciamento base.
 * 1. Operador não vê configurações (403); admin edita (auditado).
 * 2. Backup manual gera arquivo .gz com checksum registrado.
 * 3. Restauração valida checksum (arquivo corrompido é rejeitado).
 * 4. Licença: sem licença → status sem_licenca (não trava o boot).
 */
import fs from 'node:fs';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';

const PORT = Number(process.env.KIVO_PORT ?? 3299);
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

async function loginAs(username: string, password: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

async function main() {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'op2', name: 'op2', password: '123456', roleSlug: 'operador' }),
  }, admin!);
  const op = await loginAs('op2', '123456');

  // 1. Configurações
  check('operador não vê configurações (403)', (await api('/api/settings', {}, op!)).status === 403);
  const put = await api('/api/settings/empresa.nome', { method: 'PUT', body: JSON.stringify({ value: 'Taiksu' }) }, admin!);
  check('admin edita configuração', put.status === 200);
  const list = (await (await api('/api/settings', {}, admin!)).json()) as { key: string; value: string }[];
  check('configuração persistida', list.some((s) => s.key === 'empresa.nome' && s.value === 'Taiksu'));

  // 2. Backup
  check('operador não executa backup (403)', (await api('/api/backup', { method: 'POST' }, op!)).status === 403);
  const bk = await api('/api/backup', { method: 'POST' }, admin!);
  check('admin executa backup', bk.status === 201);
  const backup = (await bk.json()) as { id: number; filePath: string; checksum: string };
  check('arquivo .gz existe', fs.existsSync(backup.filePath));
  check('checksum registrado (64 hex)', /^[a-f0-9]{64}$/.test(backup.checksum));

  // 3. Restore com validação de checksum
  const ok = await api(`/api/backup/${backup.id}/restore`, { method: 'POST' }, admin!);
  check('restauração com checksum válido funciona', ok.status === 200);
  fs.appendFileSync(backup.filePath, 'corrompido');
  const bad = await api(`/api/backup/${backup.id}/restore`, { method: 'POST' }, admin!);
  check('arquivo corrompido é rejeitado (400)', bad.status === 400);

  // 4. Licença
  const lic = (await (await api('/api/license', {}, admin!)).json()) as { status: string; machineId: string };
  check('sem licença → status sem_licenca', lic.status === 'sem_licenca');
  check('machine ID gerado', /^[a-f0-9]{32}$/.test(lic.machineId));
  const setLic = await api('/api/license', {
    method: 'PUT',
    body: JSON.stringify({ companyUuid: 'c0ffee00-0000-4000-8000-000000000000', licenseKey: 'KIVO-TESTE', plan: 'pro', validUntil: '2027-01-01' }),
  }, admin!);
  const setLicBody = (await setLic.json()) as { status: string; canSaveToCloud?: boolean; canAutoUpdate?: boolean };
  check('admin configura licença → valida', setLic.status === 200 && setLicBody.status === 'valida');
  // Regressão: PUT precisa devolver o mesmo formato do GET (canSaveToCloud/canAutoUpdate) —
  // sem isso, o botão "Sincronizar agora" ficava desabilitado até a página recarregar.
  check('PUT /api/license já devolve canSaveToCloud/canAutoUpdate', setLicBody.canSaveToCloud !== undefined && setLicBody.canAutoUpdate !== undefined);

  // Auditoria cobre as novas entidades
  const audit = getSqlite().prepare('SELECT DISTINCT entity FROM audit_logs').all() as { entity: string }[];
  const entities = new Set(audit.map((a) => a.entity));
  check('auditoria cobre setting/backup/license', entities.has('setting') && entities.has('backup') && entities.has('license'));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nFase 1b: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
