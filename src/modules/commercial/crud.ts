import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { BaseRepository } from '../../core/database/repository';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { validateDocument } from '../../shared/documents';
import { validateBody } from '../../shared/validateBody';
import { machineId } from '../../core/license/service';

export interface CrudConfig {
  table: string;
  entity: string;
  permPrefix: string;
  fields: string[];
  required: string[];
  readOnlyFields?: string[];
  /** Colunas incluídas na busca textual do parâmetro `q` (padrão: `['name']`). */
  searchFields?: string[];
  /** Colunas em que o `q` também é comparado só pelos dígitos (CPF/CNPJ, telefone). */
  digitSearchFields?: string[];
  /** Filtros exatos aceitos por query string (ex.: `active`, `price_list_id`). */
  filterFields?: string[];
  /** Campos com formato de data ISO (YYYY-MM-DD) validados na gravação. */
  dateFields?: string[];
  /** Garante CPF/CNPJ único (comparando apenas os dígitos). */
  uniqueDocument?: boolean;
  /** Colunas liberadas para edição em massa via `POST /bulk-update`. */
  bulkUpdateFields?: string[];
  /** Expressões extras no SELECT da listagem (ex.: métricas calculadas). */
  computedSelect?: string[];
  /** Filtros específicos da entidade, montados a partir da query string. */
  customListWhere?: (req: Request) => { sql: string; params: unknown[] } | null;
}

/**
 * Um campo desta fábrica sempre acaba num parâmetro de SQL, e o `better-sqlite3` só aceita
 * escalar. Mandar `{"name":{"a":1}}` para /api/commercial/customers estourava lá embaixo,
 * no bind — resposta 500 e stack no log, quando o certo é 400 dizendo qual campo veio
 * errado. Este é o formato genérico que cobre as entidades da fábrica (clientes,
 * fornecedores, empresas conveniadas) sem precisar declarar schema para cada uma.
 */
const crudScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function crudBodySchema(cfg: CrudConfig) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of cfg.fields) shape[f] = crudScalar.optional();
  // `active` não está em `fields` (é coluna de todas as tabelas da fábrica) mas o UPDATE lê.
  shape.active = z.union([z.boolean(), z.number().int()]).nullable().optional();
  return z.object(shape);
}

const bulkDeleteSchema = z.object({
  ids: z.array(z.union([z.number().int().positive(), z.string().min(1)]))
    .min(1, 'Informe ao menos um id.'),
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Só os dígitos de um valor — usado para comparar CPF/CNPJ/telefone sem máscara. */
function onlyDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Normaliza um valor de query para comparação exata (booleano/número/texto). */
function filterValue(raw: unknown): string | number {
  const s = String(raw);
  if (s === 'true') return 1;
  if (s === 'false') return 0;
  const n = Number(s);
  return Number.isFinite(n) && s.trim() !== '' ? n : s;
}

/**
 * Monta o WHERE da listagem (com alias `t`) a partir da query string, aplicando busca
 * textual, filtros exatos e os filtros específicos da entidade. Exportado para que rotas
 * de exportação reaproveitem exatamente os mesmos filtros da tela.
 */
export function buildCrudListWhere(cfg: CrudConfig, req: Request): { where: string; params: unknown[] } {
  const clauses: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];

  const q = String(req.query.q ?? '').trim();
  const searchFields = cfg.searchFields ?? ['name'];
  if (q && searchFields.length) {
    const digits = onlyDigits(q);
    const ors: string[] = [];
    for (const f of searchFields) {
      ors.push(`t.${f} LIKE ?`);
      params.push(`%${q}%`);
      if (digits && (cfg.digitSearchFields ?? []).includes(f)) {
        ors.push(`REPLACE(REPLACE(REPLACE(REPLACE(t.${f}, '.', ''), '-', ''), '/', ''), ' ', '') LIKE ?`);
        params.push(`%${digits}%`);
      }
    }
    clauses.push(`(${ors.join(' OR ')})`);
  }

  for (const f of cfg.filterFields ?? []) {
    const raw = req.query[f];
    if (raw === undefined || raw === '') continue;
    if (raw === 'null') {
      clauses.push(`t.${f} IS NULL`);
      continue;
    }
    clauses.push(`t.${f} = ?`);
    params.push(filterValue(raw));
  }

  const custom = cfg.customListWhere?.(req);
  if (custom?.sql) {
    clauses.push(`(${custom.sql})`);
    params.push(...custom.params);
  }

  return { where: clauses.join(' AND '), params };
}

export function makeCrudRouter(cfg: CrudConfig): Router {
  const router = Router();
  const repo = new BaseRepository(cfg.table);
  const cols = ['id', ...cfg.fields, ...(cfg.readOnlyFields ?? []), 'active', 'updated_at'].join(', ');
  const listCols = [
    't.id',
    ...cfg.fields.map((f) => `t.${f}`),
    ...(cfg.readOnlyFields ?? []).map((f) => `t.${f}`),
    't.active',
    't.updated_at',
    ...(cfg.computedSelect ?? []),
  ].join(', ');
  const bodySchema = crudBodySchema(cfg);

  const get = (id: string | number) =>
    repo.rawOne(`SELECT ${cols} FROM ${cfg.table} WHERE id = ? AND deleted_at IS NULL`, id);

  /** CPF/CNPJ já cadastrado (comparando só os dígitos), ignorando o próprio registro. */
  const findDuplicateDocument = (document: unknown, excludeId?: string): { id: number; name: string } | undefined => {
    const digits = onlyDigits(document);
    if (!digits) return undefined;
    const extra = excludeId ? ' AND id != ?' : '';
    return repo.rawOne(
      `SELECT id, name FROM ${cfg.table}
        WHERE deleted_at IS NULL
          AND REPLACE(REPLACE(REPLACE(REPLACE(document, '.', ''), '-', ''), '/', ''), ' ', '') = ?${extra}
        LIMIT 1`,
      ...(excludeId ? [digits, excludeId] : [digits]),
    ) as { id: number; name: string } | undefined;
  };

  /** Valida os campos de data e documento comuns a POST/PUT. Devolve a mensagem de erro. */
  const validateFields = (body: Record<string, unknown>): string | null => {
    for (const f of cfg.dateFields ?? []) {
      const v = body[f];
      if (v != null && String(v).trim() !== '' && !ISO_DATE_RE.test(String(v))) {
        return `Data inválida em "${f}" (use AAAA-MM-DD).`;
      }
    }
    if (body.document && !validateDocument(String(body.document))) {
      return 'CPF/CNPJ inválido.';
    }
    return null;
  };

  router.get('/', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const { where, params } = buildCrudListWhere(cfg, req);

    const countRow = repo.rawOne(`SELECT COUNT(*) AS cnt FROM ${cfg.table} t WHERE ${where}`, ...params) as
      | { cnt: number }
      | undefined;
    const total = countRow?.cnt ?? 0;

    let sql = `SELECT ${listCols} FROM ${cfg.table} t WHERE ${where} ORDER BY t.name`;
    // Paginação opcional (opt-in): sem `limit` a resposta continua sendo a lista completa,
    // preservando os consumidores atuais. O total sempre vem no header X-Total-Count.
    const limit = Number(req.query.limit);
    if (Number.isFinite(limit) && limit > 0) {
      sql += ' LIMIT ?';
      params.push(Math.min(Math.floor(limit), 1000));
      const offset = Number(req.query.offset);
      if (Number.isFinite(offset) && offset > 0) {
        sql += ' OFFSET ?';
        params.push(Math.floor(offset));
      }
    }

    res.setHeader('X-Total-Count', String(total));
    res.json(repo.raw(sql, ...params));
  });

  router.get('/:id', requirePermission(`${cfg.permPrefix}.view`), (req, res) => {
    const row = get(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    res.json(row);
  });

  router.post('/', requirePermission(`${cfg.permPrefix}.create`), validateBody(bodySchema), (req, res) => {
    const body = req.body;
    for (const f of cfg.required) {
      if (!body[f]) {
        res.status(400).json({ error: `Campo obrigatório: ${f}` });
        return;
      }
    }
    const fieldError = validateFields(body);
    if (fieldError) {
      res.status(400).json({ error: fieldError });
      return;
    }
    if (cfg.uniqueDocument && body.document) {
      const dup = findDuplicateDocument(body.document);
      if (dup) {
        res.status(409).json({ error: `Já existe um cadastro com este CPF/CNPJ: ${dup.name}.` });
        return;
      }
    }
    const values = cfg.fields.map((f) => body[f] ?? null);
    const info = repo.rawRun(
      `INSERT INTO ${cfg.table} (${cfg.fields.join(', ')}, uuid, origin_machine) VALUES (${cfg.fields.map(() => '?').join(', ')}, ?, ?)`,
      ...values, randomUUID(), machineId(),
    );
    const created = get(String(info.lastInsertRowid));
    audit(req, 'criar', cfg.entity, Number(info.lastInsertRowid), null, created);
    res.status(201).json(created);
  });

  router.put('/:id', requirePermission(`${cfg.permPrefix}.edit`), validateBody(bodySchema), (req, res) => {
    const id = String(req.params.id);
    const before = get(id);
    if (!before) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    const body = req.body;
    const fieldError = validateFields(body);
    if (fieldError) {
      res.status(400).json({ error: fieldError });
      return;
    }
    if (cfg.uniqueDocument && body.document) {
      const dup = findDuplicateDocument(body.document, id);
      if (dup) {
        res.status(409).json({ error: `Já existe um cadastro com este CPF/CNPJ: ${dup.name}.` });
        return;
      }
    }
    const sets = cfg.fields.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
    repo.rawRun(
      `UPDATE ${cfg.table} SET ${sets}, active = COALESCE(?, active), updated_at = datetime('now'), origin_machine = ? WHERE id = ?`,
      ...cfg.fields.map((f) => body[f] ?? null),
      body.active != null ? (body.active ? 1 : 0) : null, machineId(), id,
    );
    const after = get(id);
    audit(req, 'editar', cfg.entity, id, before, after);
    res.json(after);
  });

  router.delete('/:id', requirePermission(`${cfg.permPrefix}.delete`), (req, res) => {
    const id = String(req.params.id);
    const before = get(id);
    if (!before) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    repo.softDelete(id);
    audit(req, 'excluir', cfg.entity, id, before, null);
    res.json({ ok: true });
  });

  router.post('/bulk-delete', requirePermission(`${cfg.permPrefix}.delete`), validateBody(bulkDeleteSchema), (req, res) => {
    const bodyIds = req.body.ids as (number | string)[];
    const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
    const deletedIds: string[] = [];
    const skipped: string[] = [];
    repo.transaction(() => {
      for (const id of ids) {
        const before = get(id);
        if (!before) {
          skipped.push(id);
          continue;
        }
        repo.softDelete(id);
        audit(req, 'excluir', cfg.entity, id, before, null);
        deletedIds.push(id);
      }
    });
    res.json({ deleted: deletedIds.length, deletedIds, skipped });
  });

  // Edição em massa (ativar/desativar, trocar lista de preço/convênio) — só quando a
  // entidade declara quais colunas podem ser alteradas em lote.
  if (cfg.bulkUpdateFields?.length) {
    const bulkUpdateSchema = z.object({
      ids: z.array(z.union([z.number().int().positive(), z.string().min(1)]))
        .min(1, 'Informe ao menos um id.'),
      patch: z.object(
        Object.fromEntries(cfg.bulkUpdateFields.map((f) => [f, crudScalar.optional()])),
      ),
    });

    router.post('/bulk-update', requirePermission(`${cfg.permPrefix}.edit`), validateBody(bulkUpdateSchema), (req, res) => {
      const bodyIds = req.body.ids as (number | string)[];
      const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
      const patch = req.body.patch as Record<string, unknown>;

      const sets: string[] = [];
      const params: unknown[] = [];
      for (const f of cfg.bulkUpdateFields!) {
        if (!(f in patch)) continue;
        sets.push(`${f} = ?`);
        params.push(f === 'active' ? (patch[f] ? 1 : 0) : (patch[f] ?? null));
      }
      if (!sets.length) {
        res.status(400).json({ error: 'Nenhuma alteração informada.' });
        return;
      }

      const placeholders = ids.map(() => '?').join(',');
      let updated = 0;
      repo.transaction(() => {
        const before = repo.raw(
          `SELECT ${cols} FROM ${cfg.table} WHERE deleted_at IS NULL AND id IN (${placeholders})`,
          ...ids,
        );
        const info = repo.rawRun(
          `UPDATE ${cfg.table} SET ${sets.join(', ')}, updated_at = datetime('now'), origin_machine = ?
            WHERE deleted_at IS NULL AND id IN (${placeholders})`,
          ...params, machineId(), ...ids,
        );
        updated = info.changes;
        audit(req, 'editar', cfg.entity, 0, before, { patch, ids });
      });
      res.json({ updated });
    });
  }

  return router;
}
