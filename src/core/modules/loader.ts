import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express, Router, Request, Response, NextFunction } from 'express';
import { getSqlite } from '../database/connection';
import { registerSyncTables } from '../sync/registry';
import { isModuleEntitled } from '../license/service';
import type { LoadedModule, ModuleManifest, ModuleMenuItem } from './types';

export const CORE_VERSION = '0.1.0';
// Relativo a __dirname (não process.cwd()): em dev resolve para src/modules; no app
// empacotado resolve para dist/modules (mesma estrutura, ver scripts/copy-build-assets.js).
const MODULES_DIR = path.resolve(__dirname, '..', '..', 'modules');

function validateManifest(m: Partial<ModuleManifest>, dir: string): asserts m is ModuleManifest {
  for (const field of ['id', 'name', 'version', 'requiresCore'] as const) {
    if (!m[field]) throw new Error(`Manifesto inválido em ${dir}: campo "${field}" ausente.`);
  }
}

/** Checagem simples de ">=x.y.z" contra a versão do Core. */
function satisfiesCore(requires: string): boolean {
  const match = requires.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const req = match.slice(1, 4).map(Number);
  const cur = CORE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (cur[i] > req[i]) return true;
    if (cur[i] < req[i]) return false;
  }
  return true;
}

function findManifest(dir: string): string | null {
  for (const f of ['module.manifest.ts', 'module.manifest.js']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Carrega manifesto/rotas/setup de um módulo por caminho absoluto.
 * `require()` direto (não `import()`) — o `tsc` (module: commonjs) rebaixa `import()`
 * dinâmico para `require(url.pathToFileURL(p).href)`, e `require()` do Node não aceita
 * URL `file://` como especificador (só caminhos crus) — isso só quebra rodando o build
 * compilado via `node` puro (nunca em dev via `tsx`, que transpila diferente).
 */
async function importFile(p: string) {
  return require(p);
}

async function importRouter(dir: string, spec: string | Router): Promise<Router | undefined> {
  if (typeof spec !== 'string') return spec;
  const basePath = path.join(dir, spec);
  const resolved = [basePath, `${basePath}.ts`, `${basePath}.js`].find((p) => fs.existsSync(p));
  if (!resolved) throw new Error(`Arquivo de rotas não encontrado: ${basePath}`);
  const mod = await importFile(resolved);
  return mod.default ?? mod.router;
}

/** Upsert do módulo na tabela `modules` (registro de instalação). */
function registerInDb(m: ModuleManifest, enabled: boolean): void {
  getSqlite()
    .prepare(
      `INSERT INTO modules (module_id, name, version, enabled, uuid, comment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(module_id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         enabled = excluded.enabled,
         updated_at = datetime('now')`,
    )
    .run(
      m.id,
      m.name,
      m.version,
      enabled ? 1 : 0,
      randomUUID(),
      'Registro dos módulos (Apps) instalados: id, nome, versão e estado. O Core lê esta tabela no boot para saber quais Apps carregar.',
    );
}

/** Upsert das capabilities do manifesto: insere se nova (enabled=0), preserva enabled se já existe. */
export function registerCapabilities(m: ModuleManifest): void {
  if (!m.capabilities?.length) return;
  const db = getSqlite();
  const upsert = db.prepare(
    `INSERT INTO capabilities (key, description, module, enabled, uuid) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET description = excluded.description, module = excluded.module`,
  );
  for (const cap of m.capabilities) {
    upsert.run(cap.key, cap.description, m.id, randomUUID());
  }
}

/** Registra as permissões do manifesto no catálogo e concede tudo ao Administrador. */
function registerPermissions(m: ModuleManifest): void {
  if (!m.permissions?.length) return;
  const db = getSqlite();
  const insertPerm = db.prepare(
    `INSERT INTO permissions (key, description, module) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET description = excluded.description, module = excluded.module`,
  );
  const admin = db.prepare("SELECT id FROM roles WHERE slug = 'administrador'").get() as
    | { id: number }
    | undefined;
  const grant = admin
    ? db.prepare(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)
         ON CONFLICT(role_id, permission_key) DO NOTHING`,
      )
    : null;
  for (const p of m.permissions) {
    const key = typeof p === 'string' ? p : p.key;
    const description = typeof p === 'string' ? key : p.description;
    insertPerm.run(key, description, m.id);
    grant?.run(admin!.id, key);
  }
}

/** Menu agregado de todos os módulos carregados (para a UI) — cada item marcado com
 * o módulo dono, para ser filtrado por entitlement a cada requisição (ver
 * `filterModuleMenu`), não travado no que valia no boot. */
export function collectMenu(modules: LoadedModule[]): ModuleMenuItem[] {
  return modules.flatMap((m) => (m.manifest.menu ?? []).map((item) => ({ ...item, moduleId: m.manifest.id })));
}

/**
 * Filtra `app.locals.moduleMenu` (todos os módulos compatíveis, sempre carregados)
 * pelo entitlement ATUAL a cada requisição — troca de plano/módulo aparece no
 * próximo clique, sem precisar reiniciar o Kivo.
 */
export function filterModuleMenu(req: Request, res: Response, next: NextFunction): void {
  const all = (req.app.locals.moduleMenu ?? []) as ModuleMenuItem[];
  res.locals.moduleMenu = all.filter((item) => !item.moduleId || isModuleEntitled(item.moduleId));
  next();
}

/**
 * Bloqueia acesso a um módulo fora do plano contratado — checado a cada requisição
 * (não só no boot), então mudar de plano faz efeito imediato para quem estiver online.
 */
function requireModuleEntitlement(moduleId: string, kind: 'api' | 'page') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isModuleEntitled(moduleId)) {
      next();
      return;
    }
    if (kind === 'api') {
      res.status(403).json({ error: `Módulo "${moduleId}" não incluído no plano contratado.` });
    } else {
      res.redirect('/');
    }
  };
}

/**
 * Descobre, valida e carrega todos os módulos em src/modules/. Todo módulo
 * compatível com o Core é sempre carregado — o plano contratado só decide se as
 * rotas ficam ACESSÍVEIS (via `requireModuleEntitlement`, checado a cada
 * requisição), nunca se o código é montado. Isso permite trocar de plano e ver o
 * efeito na hora, sem reiniciar o app.
 */
interface ModuleDiscovery {
  dir: string;
  manifest: ModuleManifest;
  manifestPath: string;
}

function topologicalSort(modules: ModuleDiscovery[]): ModuleDiscovery[] {
  const visited = new Set<string>();
  const sorted: ModuleDiscovery[] = [];
  const byId = new Map(modules.map((m) => [m.manifest.id, m]));

  function visit(m: ModuleDiscovery) {
    if (visited.has(m.manifest.id)) return;
    visited.add(m.manifest.id);
    for (const dep of m.manifest.dependsOn ?? []) {
      const depModule = byId.get(dep);
      if (depModule) visit(depModule);
    }
    sorted.push(m);
  }

  for (const m of modules) visit(m);
  return sorted;
}

export async function loadModules(app: Express): Promise<LoadedModule[]> {
  if (!fs.existsSync(MODULES_DIR)) return [];
  const loaded: LoadedModule[] = [];

  // Primeira passada: descobre todos os módulos
  const discovered: ModuleDiscovery[] = [];
  for (const entry of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MODULES_DIR, entry.name);
    const manifestPath = findManifest(dir);
    if (!manifestPath) continue;

    const imported = await importFile(manifestPath);
    const manifestRaw: Partial<ModuleManifest> = imported.default ?? imported;
    validateManifest(manifestRaw, dir);

    if (!satisfiesCore(manifestRaw.requiresCore)) {
      console.warn(`[modules] "${manifestRaw.id}" exige Core ${manifestRaw.requiresCore} — ignorado.`);
      continue;
    }

    discovered.push({ dir, manifest: manifestRaw as ModuleManifest, manifestPath });
  }

  // Ordenação topológica respeitando dependsOn
  const sorted = topologicalSort(discovered);

  // Segunda passada: carrega na ordem correta
  for (const { dir, manifest } of sorted) {
    // setup: registra serviços do módulo no Core ANTES das rotas
    if (manifest.setup) {
      const basePath = path.join(dir, manifest.setup);
      const resolved = [basePath, `${basePath}.ts`, `${basePath}.js`].find((p) => fs.existsSync(p));
      if (resolved) {
        const setupModule = await importFile(resolved);
        await (setupModule.default ?? setupModule.setup)?.();
      }
    }

    const router = manifest.routes ? await importRouter(dir, manifest.routes) : undefined;
    if (router) app.use(`/api/${manifest.id}`, requireModuleEntitlement(manifest.id, 'api'), router);

    const pagesRouter = manifest.pages ? await importRouter(dir, manifest.pages) : undefined;
    if (pagesRouter) app.use(`/app/${manifest.id}`, requireModuleEntitlement(manifest.id, 'page'), pagesRouter);

    const viewsDir = manifest.views ? path.join(dir, manifest.views) : undefined;

    registerInDb(manifest, true);
    registerPermissions(manifest);
    registerCapabilities(manifest);
    registerSyncTables(manifest.id, manifest.syncTables);
    loaded.push({ manifest, dir, router, pagesRouter, viewsDir });
    console.log(`[modules] carregado: ${manifest.id}@${manifest.version}`);
  }
  return loaded;
}
