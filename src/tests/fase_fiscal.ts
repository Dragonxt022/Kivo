/**
 * Teste do módulo fiscal (F1 — beta + configuração):
 * 1. migrations 0054–0056 criam tabelas, colunas e índices esperados;
 * 2. a capability `fiscal.nfce` nasce desligada e marcada como beta;
 * 3. com o beta desligado: API 403, página redireciona e o menu não mostra o item;
 * 4. numeração reservada de forma atômica e SEPARADA por ambiente;
 * 5. o cofre de segredos não grava em texto puro e não vaza em GET /api/settings;
 * 6. a troca para produção só passa depois de uma emissão de teste aprovada;
 * 7. o diagnóstico de prontidão conta produtos sem NCM e reprova config incompleta.
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3606);
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
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

  // ── 1. Migrations ────────────────────────────────────────────────────────────
  const docCols = cols('fiscal_documents');
  check('fiscal_documents criada', docCols.length > 0);
  check(
    'fiscal_documents tem environment/xml_path/cpf_dest/is_test',
    ['environment', 'xml_path', 'cpf_dest', 'is_test'].every((c) => docCols.includes(c)),
  );
  check('fiscal_sequences tem environment', cols('fiscal_sequences').includes('environment'));
  check(
    'products ganhou colunas fiscais (inclusive origem)',
    ['ncm', 'cest', 'csosn', 'cst', 'origem', 'unit_fiscal'].every((c) => cols('products').includes(c)),
  );
  check('customers ganhou ie', cols('customers').includes('ie'));
  // O plano original re-adicionava `phone`; conferir que continua existindo uma só vez.
  check('customers.phone não foi duplicada', cols('customers').filter((c) => c === 'phone').length === 1);
  check('capabilities ganhou beta', cols('capabilities').includes('beta'));

  const indexes = (db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('fiscal_documents','fiscal_sequences')",
    )
    .all() as { name: string }[]).map((r) => r.name);
  check('índice único de numeração existe', indexes.includes('idx_fiscal_docs_num'));
  check('índice único parcial da chave existe', indexes.includes('idx_fiscal_docs_key'));

  // ── 2. Capability nasce desligada e marcada como beta ────────────────────────
  const cap = db.prepare("SELECT enabled, beta, module FROM capabilities WHERE key = 'fiscal.nfce'").get() as
    | { enabled: number; beta: number; module: string }
    | undefined;
  check('capability fiscal.nfce registrada', !!cap);
  check('fiscal.nfce começa desligada', cap?.enabled === 0);
  check('fiscal.nfce marcada como beta', cap?.beta === 1);
  check('fiscal.nfce pertence ao módulo fiscal', cap?.module === 'fiscal');

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // ── 3. Beta desligado: invisível e inerte ────────────────────────────────────
  const offRes = await api('/api/fiscal/config', {}, admin!);
  check('beta off: API responde 403', offRes.status === 403);
  const offBody = (await offRes.json()) as { error?: string };
  check(
    'beta off: erro no formato que a UI intercepta',
    offBody.error === 'Recurso desativado: fiscal.nfce',
    offBody.error,
  );

  const homeOff = await (await api('/', {}, admin!)).text();
  check('beta off: menu não mostra Notas Fiscais', !homeOff.includes('/app/fiscal/notas'));

  const pageOff = await fetch(`${base}/app/fiscal/configuracao`, {
    headers: { cookie: admin! },
    redirect: 'manual',
  });
  check('beta off: página redireciona', pageOff.status === 302);

  // ── 4. Ativação ──────────────────────────────────────────────────────────────
  const enable = await api(
    '/api/core/capabilities/fiscal.nfce',
    { method: 'PUT', body: JSON.stringify({ enabled: true }) },
    admin!,
  );
  check('ativa fiscal.nfce', enable.status === 200);

  const homeOn = await (await api('/', {}, admin!)).text();
  check('beta on: menu passa a mostrar Notas Fiscais', homeOn.includes('/app/fiscal/notas'));
  check('beta on: API responde', (await api('/api/fiscal/config', {}, admin!)).status === 200);

  // ── 5. Numeração atômica e separada por ambiente ─────────────────────────────
  const { fiscalSequenceRepository } = await import('../modules/fiscal/repositories/FiscalDocumentRepository');
  const homolog = [1, 2, 3].map(() => fiscalSequenceRepository.reserveNext('65', 1, 2));
  check('reserva sequencial em homologação', JSON.stringify(homolog) === '[1,2,3]', homolog.join(','));
  const prod = [1, 2].map(() => fiscalSequenceRepository.reserveNext('65', 1, 1));
  check('produção tem numeração própria', JSON.stringify(prod) === '[1,2]', prod.join(','));
  check('homologação continua de onde parou', fiscalSequenceRepository.reserveNext('65', 1, 2) === 4);
  check('série 2 é independente', fiscalSequenceRepository.reserveNext('65', 2, 2) === 1);

  // Número repetido na mesma série/ambiente é barrado pelo índice único.
  const insert = (n: number, env: number) =>
    db
      .prepare(
        `INSERT INTO fiscal_documents (model, serie, number, environment, total_cents, uuid)
         VALUES ('65', 1, ?, ?, 100, ?)`,
      )
      .run(n, env, `uuid-${env}-${n}-${Math.random()}`);
  insert(10, 2);
  let duplicado = false;
  try {
    insert(10, 2);
  } catch {
    duplicado = true;
  }
  check('número repetido na mesma série/ambiente é rejeitado', duplicado);
  let outroAmbiente = true;
  try {
    insert(10, 1);
  } catch {
    outroAmbiente = false;
  }
  check('mesmo número em outro ambiente é aceito', outroAmbiente);

  // ── 6. Cofre de segredos ─────────────────────────────────────────────────────
  const secrets = await import('../core/secrets/service');
  const fs = await import('node:fs');
  secrets.setSecret('fiscal.csc', 'SEGREDO-CSC-123456');
  check('cofre devolve o valor gravado', secrets.getSecret('fiscal.csc') === 'SEGREDO-CSC-123456');
  check('cofre sabe que a chave existe', secrets.hasSecret('fiscal.csc'));
  const vaultRaw = fs.readFileSync(secrets.secretsFilePath(), 'utf8');
  check('cofre não grava em texto puro', !vaultRaw.includes('SEGREDO-CSC-123456'));

  const allSettings = await unwrap<{ key: string; value: string }[]>(await api('/api/settings', {}, admin!));
  const settingsBlob = JSON.stringify(allSettings);
  check('CSC não aparece em GET /api/settings', !settingsBlob.includes('SEGREDO-CSC-123456'));
  check(
    'nenhuma chave de segredo em settings',
    !allSettings.some((s) => ['fiscal.csc', 'fiscal.cert_senha', 'fiscal.provider_token'].includes(s.key)),
  );
  secrets.deleteSecret('fiscal.csc');
  check('cofre remove a chave', secrets.getSecret('fiscal.csc') === null);

  // ── 7. Trava de ambiente ─────────────────────────────────────────────────────
  const cfgSvc = await import('../modules/fiscal/services/config');
  check('ambiente começa em homologação', cfgSvc.getConfig().ambiente === 2);

  const tentaProd = await api('/api/fiscal/ambiente', { method: 'PUT', body: JSON.stringify({ ambiente: 1 }) }, admin!);
  check('produção barrada sem teste aprovado', tentaProd.status === 400);
  check('ambiente continua em homologação', cfgSvc.getConfig().ambiente === 2);

  cfgSvc.markTestPassed();
  const liberaProd = await api('/api/fiscal/ambiente', { method: 'PUT', body: JSON.stringify({ ambiente: 1 }) }, admin!);
  check('produção liberada após teste aprovado', liberaProd.status === 200);
  check('ambiente agora é produção', cfgSvc.getConfig().ambiente === 1);

  const volta = await api('/api/fiscal/ambiente', { method: 'PUT', body: JSON.stringify({ ambiente: 2 }) }, admin!);
  check('voltar para homologação é sempre permitido', volta.status === 200 && cfgSvc.getConfig().ambiente === 2);

  // ── 8. Prontidão ─────────────────────────────────────────────────────────────
  const readiness = await import('../modules/fiscal/services/readiness');
  const vazio = readiness.checkReadiness();
  check('configuração vazia não está pronta', !vazio.ready);
  check(
    'diagnóstico aponta empresa, certificado, CSC e emissor',
    ['empresa', 'certificado', 'csc', 'emissor'].every((id) =>
      vazio.checks.some((c) => c.id === id && c.status === 'fail'),
    ),
  );

  db.prepare("INSERT INTO products (name, uuid, ncm) VALUES ('Com NCM', 'p-ncm-1', '22021000')").run();
  db.prepare("INSERT INTO products (name, uuid) VALUES ('Sem NCM', 'p-ncm-2')").run();
  db.prepare("INSERT INTO products (name, uuid, product_type) VALUES ('Serviço', 'p-ncm-3', 'servico')").run();
  // Complemento vira linha própria na venda → precisa de NCM próprio, entra na conta.
  db.prepare("INSERT INTO products (name, uuid, product_type) VALUES ('Bacon extra', 'p-ncm-4', 'complemento')").run();
  // Variante filha herda a classificação do pai → fica fora da conta.
  const paiId = Number(
    db.prepare("INSERT INTO products (name, uuid, product_type, ncm) VALUES ('Camiseta', 'p-ncm-5', 'variante', '61091000')").run().lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO products (name, uuid, product_type, parent_product_id) VALUES ('Camiseta azul M', 'p-ncm-6', 'variante', ?)",
  ).run(paiId);

  const comProdutos = readiness.checkReadiness();
  check('conta produtos sem NCM', comProdutos.produtosSemNcm === 2, String(comProdutos.produtosSemNcm));
  check(
    'serviço fora e complemento dentro da conta',
    comProdutos.produtosTotal === 4,
    String(comProdutos.produtosTotal),
  );
  check(
    'pendência de NCM aparece com ação',
    comProdutos.checks.some((c) => c.id === 'ncm' && c.status === 'fail' && !!c.actionHref),
  );

  // ── 9. Gravação em lote dos dados fiscais do produto ─────────────────────────
  // Regressão: `/products/fiscal` tem que ser declarada ANTES de `/products/:id`,
  // senão o Express casa "fiscal" como id e devolve "Produto não encontrado".
  const semNcmId = (db.prepare("SELECT id FROM products WHERE uuid = 'p-ncm-2'").get() as { id: number }).id;
  const lote = await api(
    '/api/commercial/products/fiscal',
    { method: 'PUT', body: JSON.stringify({ ids: [semNcmId], patch: { ncm: '2202.10.00', origem: 0 } }) },
    admin!,
  );
  check('gravação em lote responde 200', lote.status === 200);
  const gravado = db.prepare('SELECT ncm, origem FROM products WHERE id = ?').get(semNcmId) as {
    ncm: string | null;
    origem: number | null;
  };
  check('NCM gravado só com dígitos', gravado.ncm === '22021000', String(gravado.ncm));
  check('origem gravada', gravado.origem === 0, String(gravado.origem));
  check('prontidão reflete a gravação', readiness.checkReadiness().produtosSemNcm === 1);

  const ncmInvalido = await api(
    '/api/commercial/products/fiscal',
    { method: 'PUT', body: JSON.stringify({ ids: [semNcmId], patch: { ncm: '2202' } }) },
    admin!,
  );
  check('NCM com menos de 8 dígitos é recusado', ncmInvalido.status === 400);

  // A rota genérica de produto continua funcionando (não foi engolida pela nova).
  const produtoNormal = await api(
    `/api/commercial/products/${semNcmId}`,
    { method: 'PUT', body: JSON.stringify({ name: 'Sem NCM renomeado' }) },
    admin!,
  );
  check('PUT /products/:id continua funcionando', produtoNormal.status === 200, String(produtoNormal.status));

  // ── 10. Guarda no cancelamento da venda ──────────────────────────────────────
  const { hasService, getService } = await import('../core/services/registry');
  check('módulo fiscal expõe fiscal.documents', hasService('fiscal.documents'));
  const fiscalSvc = getService<{ hasLiveDocument(id: number): boolean }>('fiscal.documents');
  // Venda real: `fiscal_documents.sale_id` tem FK para `sales`, e as FKs ficam ativas fora
  // das migrations.
  const vendaId = Number(
    db
      .prepare(
        `INSERT INTO sales (subtotal_cents, total_cents, payment_method, uuid)
         VALUES (500, 500, 'dinheiro', 'uuid-venda-fiscal')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO fiscal_documents (model, serie, number, environment, status, sale_id, total_cents, uuid)
     VALUES ('65', 9, 1, 2, 'autorizada', ?, 500, 'uuid-venda-viva')`,
  ).run(vendaId);
  check('venda com nota autorizada é detectada', fiscalSvc.hasLiveDocument(vendaId));
  check('venda sem nota não é detectada', !fiscalSvc.hasLiveDocument(vendaId + 1000));
  db.prepare("UPDATE fiscal_documents SET status = 'cancelada' WHERE sale_id = ?").run(vendaId);
  check('nota cancelada libera a venda', !fiscalSvc.hasLiveDocument(vendaId));

  server.close();
  closeDb();
  console.log(failures === 0 ? '\nFiscal: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
