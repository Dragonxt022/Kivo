import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Colunas do contrato de sincronização (KIVO_PLANO.md §6)
 * + coluna `comment` obrigatória em toda tabela, descrevendo o objetivo da tabela.
 */
const syncColumns = {
  uuid: text('uuid').notNull().unique(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
  syncedAt: text('synced_at'),
  originMachine: text('origin_machine'),
};

/** Registro dos módulos (Apps) instalados. */
export const modules = sqliteTable('modules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  moduleId: text('module_id').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  enabled: integer('enabled').notNull().default(1),
  installedAt: text('installed_at').notNull(),
  ...syncColumns,
  comment: text('comment').notNull(),
});

/** Configurações chave-valor do Core. */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  value: text('value'),
  ...syncColumns,
  comment: text('comment').notNull(),
});
