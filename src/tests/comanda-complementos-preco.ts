/**
 * Teste: o preço do complemento (override do grupo) entra na comanda e na venda.
 *
 * Regressão real: a modal mostrava `price_override_cents`, mas o servidor resolvia
 * apenas `products.price_cents`. Quando o complemento tinha catálogo R$ 0,00 (ou um
 * valor diferente do override), a linha entrava zerada/errada e o total do PDV e do
 * cupom não batia com o que o garçom viu na tela.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — este teste recria o banco que usar:
 *   node scripts/test-isolated.js src/tests/comanda-complementos-preco.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3827);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let cookie = '';

async function api(p: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error('KIVO_DB_PATH não definida. Rode via `node scripts/test-isolated.js src/tests/comanda-complementos-preco.ts`.');
  }
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kivo.db')) {
    throw new Error('Recusado: KIVO_DB_PATH aponta para o banco de dev.');
  }
  return alvo;
}

interface ComandaItem {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  line_group_uuid: string | null;
}

async function getComanda(comandaId: number): Promise<ComandaItem[]> {
  const b = await unwrap<{ items?: ComandaItem[] }>(await api(`/api/comandas/comandas/${comandaId}`));
  return b.items ?? [];
}

function total(items: ComandaItem[]): number {
  return items.reduce((a, i) => a + i.unit_price_cents * i.qty, 0);
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const m = (login.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
    cookie = m ? `kivo_session=${m[1]}` : '';
    check('login admin', cookie !== '');
    if (!cookie) return;

    db.prepare("UPDATE capabilities SET enabled = 1 WHERE key = 'comandas.mesas'").run();

    // Hamburguer (principal) + adicional com catálogo R$ 0,00 e override R$ 4,50.
    // Esse é o caso que sumia do total: a modal mostrava 4,50 e o item entrava 0,00.
    const principal = await unwrap<{ id: number }>(await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Hamburguer', priceCents: 2500, unit: 'un' }),
    }));
    const adicional = await unwrap<{ id: number }>(await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Bacon extra', priceCents: 0, unit: 'un' }),
    }));
    const adicionalCatalogo = await unwrap<{ id: number }>(await api('/api/commercial/products', {
      method: 'POST', body: JSON.stringify({ name: 'Cheddar', priceCents: 300, unit: 'un' }),
    }));

    const groupId = Number(db.prepare(
      "INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)",
    ).run('Adicionais', 0, 5, randomUUID()).lastInsertRowid);
    db.prepare(
      'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
    ).run(groupId, adicional.id, 450, 1, randomUUID());
    db.prepare(
      'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
    ).run(groupId, adicionalCatalogo.id, null, 2, randomUUID());
    db.prepare(
      'INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)',
    ).run(principal.id, groupId, 1, randomUUID());

    const mesa = await unwrap<{ id: number }>(await api('/api/comandas/tables', {
      method: 'POST', body: JSON.stringify({ label: 'Mesa Complementos' }),
    }));
    const comanda = await unwrap<{ id: number }>(await api('/api/comandas/comandas', {
      method: 'POST', body: JSON.stringify({ tableId: mesa.id }),
    }));

    // Mesma sequência da tela: principal primeiro, complementos depois, mesmo lineGroupUuid.
    const lineGroupUuid = randomUUID();
    const addPrincipal = await api(`/api/comandas/comandas/${comanda.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: principal.id, qty: 1, lineGroupUuid }),
    });
    check('principal lançado', addPrincipal.status === 201, `status=${addPrincipal.status}`);
    const addAdicional = await api(`/api/comandas/comandas/${comanda.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicional.id, qty: 2, lineGroupUuid }),
    });
    check('adicional lançado (sem unitPriceCents no corpo)', addAdicional.status === 201, `status=${addAdicional.status}`);

    let items = await getComanda(comanda.id);
    const itemPrincipal = items.find((i) => i.product_id === principal.id)!;
    const itemAdicional = items.find((i) => i.product_id === adicional.id)!;
    check('principal mantém preço de catálogo', itemPrincipal.unit_price_cents === 2500, `unit=${itemPrincipal.unit_price_cents}`);
    check('adicional usa price_override_cents do grupo (450)', itemAdicional.unit_price_cents === 450,
      `unit=${itemAdicional.unit_price_cents}`);
    check('total da comanda inclui o adicional (2500 + 2×450 = 3400)', total(items) === 3400, `total=${total(items)}`);

    // Mudar a quantidade do adicional NÃO pode re-resolver o preço de catálogo (0).
    const updAdicional = await api(`/api/comandas/comandas/${comanda.id}/items/${itemAdicional.id}/qty`, {
      method: 'PUT', body: JSON.stringify({ qty: 3 }),
    });
    check('altera qtd do adicional', updAdicional.ok, `status=${updAdicional.status}`);
    items = await getComanda(comanda.id);
    const itemAdicional3 = items.find((i) => i.product_id === adicional.id)!;
    check('preço do adicional continua 450 após mudar a qtd', itemAdicional3.unit_price_cents === 450,
      `unit=${itemAdicional3.unit_price_cents}`);
    check('total com 3 adicionais (2500 + 3×450 = 3850)', total(items) === 3850, `total=${total(items)}`);

    // Complemento sem override usa o catálogo (300), não 0.
    const addCatalogo = await api(`/api/comandas/comandas/${comanda.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicionalCatalogo.id, qty: 1, lineGroupUuid }),
    });
    check('complemento sem override lançado', addCatalogo.status === 201, `status=${addCatalogo.status}`);
    items = await getComanda(comanda.id);
    const itemCatalogo = items.find((i) => i.product_id === adicionalCatalogo.id)!;
    check('complemento sem override usa o catálogo (300)', itemCatalogo.unit_price_cents === 300,
      `unit=${itemCatalogo.unit_price_cents}`);

    // Mudar a quantidade do principal não pode contaminar o preço dos complementos.
    await api(`/api/comandas/comandas/${comanda.id}/items/${itemPrincipal.id}/qty`, {
      method: 'PUT', body: JSON.stringify({ qty: 2 }),
    });
    items = await getComanda(comanda.id);
    check('principal atualizado para 2 sem perder o preço',
      items.find((i) => i.product_id === principal.id)?.unit_price_cents === 2500);
    check('complementos intactos após mexer no principal',
      items.find((i) => i.product_id === adicional.id)?.unit_price_cents === 450
        && items.find((i) => i.product_id === adicionalCatalogo.id)?.unit_price_cents === 300);

    const totalComanda = total(items);
    check('total final da comanda (2×2500 + 3×450 + 300 = 6650)', totalComanda === 6650, `total=${totalComanda}`);

    const methods = await unwrap<{ id: number; type: string }[]>(await api('/api/store/payment-methods'));
    const pix = methods.find((method) => method.type === 'pix')!;
    await api('/api/finance/cash/open', { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) });

    // Fechamento como o PDV agora faz: sem reenviar os itens, o servidor usa a comanda
    // (fonte da verdade) e recalcula o override dos complementos. O cupom/PDF sai daqui.
    const close = await api(`/api/comandas/comandas/${comanda.id}/close`, {
      method: 'POST', body: JSON.stringify({ payments: [{ methodId: pix.id, amountCents: totalComanda }] }),
    });
    const closed = await unwrap<{ saleId: number }>(close);
    check('fecha comanda e gera venda', close.ok && closed.saleId > 0, `status=${close.status}`);

    const sale = await unwrap<{
      total_cents: number;
      items: { product_name: string; qty: number; unit_price_cents: number; total_cents: number }[];
    }>(await api(`/api/store/sales/${closed.saleId}`));
    const saleAdicional = sale.items.find((i) => i.product_name === 'Bacon extra')!;
    const saleCatalogo = sale.items.find((i) => i.product_name === 'Cheddar')!;
    check('venda/cupom contabiliza o override do adicional (450)', saleAdicional?.unit_price_cents === 450,
      `unit=${saleAdicional?.unit_price_cents}`);
    check('venda/cupom soma 3×450 no adicional', saleAdicional?.total_cents === 1350, `total=${saleAdicional?.total_cents}`);
    check('venda/cupom contabiliza o complemento de catálogo (300)', saleCatalogo?.unit_price_cents === 300,
      `unit=${saleCatalogo?.unit_price_cents}`);
    check('total da venda bate com a comanda (6650)', sale.total_cents === 6650, `total=${sale.total_cents}`);

    // Venda direta do PDV (balcão): sem unitPriceCents, o servidor ainda acha o
    // complemento pelo lineGroupUuid e aplica o override do grupo.
    const lineGroupBalcao = randomUUID();
    const directTotal = 2500 + 2 * 450;
    const direct = await api('/api/store/sales', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { productId: principal.id, qty: 1, lineGroupUuid: lineGroupBalcao },
          { productId: adicional.id, qty: 2, lineGroupUuid: lineGroupBalcao },
        ],
        payments: [{ methodId: pix.id, amountCents: directTotal }],
        clientRequestId: randomUUID(),
      }),
    });
    check('venda direta com complemento criada', direct.status === 201, `status=${direct.status}`);
    if (direct.ok) {
      const directBody = await unwrap<{ id: number }>(direct);
      const directSale = await unwrap<{
        total_cents: number;
        items: { product_name: string; unit_price_cents: number; total_cents: number }[];
      }>(await api(`/api/store/sales/${directBody.id}`));
      const directAdicional = directSale.items.find((i) => i.product_name === 'Bacon extra')!;
      check('venda direta aplica o override do complemento (450)',
        directAdicional?.unit_price_cents === 450, `unit=${directAdicional?.unit_price_cents}`);
      check('total da venda direta inclui o adicional (3400)',
        directSale.total_cents === directTotal, `total=${directSale.total_cents}`);
    }

    // ─── Excluir o principal leva os complementos do grupo junto ───────────────
    // Regressão: o DELETE anulava só a linha clicada e Granola/Leite ficavam soltos
    // na comanda, cobrando adicionais de um produto que não existia mais.
    const comandaVoid = await unwrap<{ id: number }>(await api('/api/comandas/comandas', {
      method: 'POST', body: JSON.stringify({}),
    }));
    const groupVoid = randomUUID();
    const principalVoid = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaVoid.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: principal.id, qty: 1, lineGroupUuid: groupVoid }),
    }));
    await api(`/api/comandas/comandas/${comandaVoid.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicional.id, qty: 2, lineGroupUuid: groupVoid }),
    });
    const antesVoid = await getComanda(comandaVoid.id);
    check('comanda de teste começa com principal + complemento', antesVoid.length === 2, `itens=${antesVoid.length}`);

    const delPrincipal = await api(`/api/comandas/comandas/${comandaVoid.id}/items/${principalVoid.id}`, { method: 'DELETE' });
    check('excluir principal responde OK', delPrincipal.ok, `status=${delPrincipal.status}`);
    const depoisVoid = await getComanda(comandaVoid.id);
    check('excluir principal remove o complemento da comanda', depoisVoid.length === 0, `itens=${depoisVoid.length}`);
    const linhasVoid = db.prepare(
      'SELECT voided_at FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL',
    ).all(comandaVoid.id) as { voided_at: string | null }[];
    check('principal e complemento ficam anulados no banco',
      linhasVoid.length === 2 && linhasVoid.every((l) => !!l.voided_at), JSON.stringify(linhasVoid));

    // Excluir um complemento específico continua removendo só ele.
    const comandaVoid2 = await unwrap<{ id: number }>(await api('/api/comandas/comandas', {
      method: 'POST', body: JSON.stringify({}),
    }));
    const groupVoid2 = randomUUID();
    const principalVoid2 = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaVoid2.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: principal.id, qty: 1, lineGroupUuid: groupVoid2 }),
    }));
    const complementoVoid2 = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaVoid2.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicional.id, qty: 1, lineGroupUuid: groupVoid2 }),
    }));
    await api(`/api/comandas/comandas/${comandaVoid2.id}/items/${complementoVoid2.id}`, { method: 'DELETE' });
    const depoisVoid2 = await getComanda(comandaVoid2.id);
    check('excluir só o complemento mantém o principal',
      depoisVoid2.length === 1 && depoisVoid2[0].id === principalVoid2.id,
      `itens=${depoisVoid2.map((i) => i.product_name).join(',')}`);

    // ─── Dados antigos: complemento órfão é limpo pela migration 0095 ─────────
    // Simula o estrago que a versão anterior deixou: principal anulado, adicional
    // ainda ativo. A migration roda uma vez no upgrade e limpa o grupo.
    const comandaLegacy = await unwrap<{ id: number }>(await api('/api/comandas/comandas', {
      method: 'POST', body: JSON.stringify({}),
    }));
    const groupLegacy = randomUUID();
    const principalLegacy = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaLegacy.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: principal.id, qty: 1, lineGroupUuid: groupLegacy }),
    }));
    const _complementoLegacy = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaLegacy.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicional.id, qty: 1, lineGroupUuid: groupLegacy }),
    }));
    db.prepare("UPDATE comanda_items SET voided_at = datetime('now') WHERE id = ?").run(principalLegacy.id);
    const antesLegacy = await getComanda(comandaLegacy.id);
    check('dado antigo deixa só o complemento ativo', antesLegacy.length === 1, `itens=${antesLegacy.length}`);

    const orphanSql = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'comandas', 'migrations', '0095_comanda_orphan_complements', 'up.sql'),
      'utf8',
    );
    db.exec(orphanSql);
    const linhasLegacy = db.prepare(
      'SELECT id, voided_at FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL ORDER BY id',
    ).all(comandaLegacy.id) as { id: number; voided_at: string | null }[];
    check('migration 0095 anula o complemento órfão',
      linhasLegacy.length === 2 && linhasLegacy.every((l) => !!l.voided_at), JSON.stringify(linhasLegacy));

    // Mesmo sem a migration (ex.: banco que não passou pelo upgrade), remover o
    // complemento restante já limpa o grupo órfão pelo próprio voidItem.
    const comandaLegacy2 = await unwrap<{ id: number }>(await api('/api/comandas/comandas', {
      method: 'POST', body: JSON.stringify({}),
    }));
    const groupLegacy2 = randomUUID();
    const principalLegacy2 = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaLegacy2.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: principal.id, qty: 1, lineGroupUuid: groupLegacy2 }),
    }));
    const complementoLegacy2 = await unwrap<{ id: number }>(await api(`/api/comandas/comandas/${comandaLegacy2.id}/items`, {
      method: 'POST', body: JSON.stringify({ productId: adicional.id, qty: 1, lineGroupUuid: groupLegacy2 }),
    }));
    db.prepare("UPDATE comanda_items SET voided_at = datetime('now') WHERE id = ?").run(principalLegacy2.id);
    const delOrfao = await api(`/api/comandas/comandas/${comandaLegacy2.id}/items/${complementoLegacy2.id}`, { method: 'DELETE' });
    check('remover complemento órfão responde OK', delOrfao.ok, `status=${delOrfao.status}`);
    const linhasLegacy2 = db.prepare(
      'SELECT voided_at FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL',
    ).all(comandaLegacy2.id) as { voided_at: string | null }[];
    check('remover complemento órfão limpa o grupo antigo',
      linhasLegacy2.length === 2 && linhasLegacy2.every((l) => !!l.voided_at), JSON.stringify(linhasLegacy2));
  } finally {
    server.close();
    closeDb();
  }

  console.log(failures === 0
    ? '\nComanda complementos/preço: TODOS OS TESTES PASSARAM'
    : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
