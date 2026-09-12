/**
 * Integração: o pacote de ícones escolhido chega na página renderizada. Sobe o servidor
 * com banco descartável, cria um pacote local, seleciona e confere que o HTML traz o SVG
 * do pacote — depois volta ao padrão.
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { closeDb } from '../core/database/connection';
import { activateTestLicense, exitFirstRunState } from './resetTestDb';
import { unwrap } from './testUtils';
import { iconPacksDir } from '../core/icons/service';

const PORT = Number(process.env.KIVO_PORT ?? 3791);
const base = `http://localhost:${PORT}`;
const MARKER = 'KIVO-PACK-MARKER';
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(pathname: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${pathname}`, {
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
  exitFirstRunState();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const packDir = path.join(iconPacksDir(), 'teste-api');

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);

    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'cart.svg'),
      `<svg viewBox="0 0 24 24" data-kivo="${MARKER}"><path d="M1 1"/></svg>`,
    );

    const lista = await unwrap<{ packs: { id: string }[]; current: string }>(
      await api('/api/settings/icon-packs', {}, admin!),
    );
    check('endpoint lista o pacote local', lista.packs.some((p) => p.id === 'teste-api'));
    check('current começa no padrão', lista.current === 'padrao', lista.current);

    const home0 = await (await api('/', {}, admin!)).text();
    check('home no padrão não traz o override', !home0.includes(MARKER));

    const put = await api('/api/settings/icon-pack', { method: 'PUT', body: JSON.stringify({ id: 'teste-api' }) }, admin!);
    check('selecionar pacote → 200', put.ok, String(put.status));

    const home1 = await (await api('/', {}, admin!)).text();
    check('home passa a trazer o SVG do pacote', home1.includes(MARKER));

    await api('/api/settings/icon-pack', { method: 'PUT', body: JSON.stringify({ id: '' }) }, admin!);
    const home2 = await (await api('/', {}, admin!)).text();
    check('volta ao padrão', !home2.includes(MARKER));

    const invalido = await api('/api/settings/icon-pack', { method: 'PUT', body: JSON.stringify({ id: 'nao-existe' }) }, admin!);
    check('pacote inexistente → 400', invalido.status === 400, String(invalido.status));
  } finally {
    server.close();
    closeDb();
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nPacotes de ícones (API): TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
