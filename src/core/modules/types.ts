import type { Router } from 'express';
import type { SyncTableSpec } from '../sync/types';

/** Item de menu injetado na UI pelo módulo (renderizado conforme permissão). */
export interface ModuleMenuItem {
  label: string;
  href: string;
  permission?: string;
  description?: string;
  icon?: string;
  /** Preenchido por collectMenu() — usado para filtrar o menu por entitlement a cada requisição. */
  moduleId?: string;
}

/** Contrato do module.manifest.ts (KATSU_PLANO.md §4). */
export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  requiresCore: string;
  /** Permissões do módulo: registradas no catálogo e concedidas ao Administrador. */
  permissions: { key: string; description: string }[] | string[];
  /** Capacidades finas do módulo: recursos ligáveis/desligáveis por empresa, dentro de um
   * módulo já contratado (ex.: 'variantes', 'kits', 'complementos'). Upsert no boot como
   * permissões — nunca resetam o `enabled` atual. */
  capabilities?: { key: string; description: string }[];
  /** Caminho relativo à pasta do módulo, ou Router direto. Montado em /api/<id>. */
  routes?: string | Router;
  /** Router de páginas (views), montado em /app/<id> com autenticação. */
  pages?: string | Router;
  /** Pasta de views EJS do módulo (relativa), adicionada ao lookup do Express. */
  views?: string;
  /** Pasta de migrations do módulo (o migrator descobre sozinho por convenção). */
  migrations?: string;
  /** Arquivo executado no boot (export default function): registra serviços no Core. */
  setup?: string;
  menu?: ModuleMenuItem[];
  /** Tabelas sincronizáveis deste módulo (motor de sync da Fase 6a, KATSU_PLANO.md §6). */
  syncTables?: SyncTableSpec[];
}

export interface LoadedModule {
  manifest: ModuleManifest;
  dir: string;
  router?: Router;
  pagesRouter?: Router;
  viewsDir?: string;
}
