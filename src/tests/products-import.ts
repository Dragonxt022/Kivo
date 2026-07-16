/**
 * Testes do parser/validador de importação de produtos (productsImport.ts).
 * Lógica pura — não abre banco nem sobe servidor, então roda em milissegundos.
 */
import {
  parseCsv, toCsv, parseMoneyToCents, parseIntField, normalizeHeader,
  buildPreview, templateCsv, type ExistingProduct,
} from '../modules/commercial/productsImport';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? '' : `esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}

// ─────────── dinheiro: o ponto onde um bug vira prejuízo ───────────
const money = (s: string) => {
  const r = parseMoneyToCents(s);
  return r.ok ? r.cents : `ERRO(${r.error})`;
};
eq('"18,90" → 1890', money('18,90'), 1890);
eq('"R$ 18,90" → 1890', money('R$ 18,90'), 1890);
eq('"1.234,56" → 123456 (ponto é milhar)', money('1.234,56'), 123456);
eq('"1234.56" → 123456 (ponto é decimal)', money('1234.56'), 123456);
eq('"1.234" → 123400 (3 dígitos após ponto = milhar)', money('1.234'), 123400);
eq('"1.234.567" → 123456700 (milhares)', money('1.234.567'), 123456700);
eq('"12.5" → 1250 (decimal de 1 casa)', money('12.5'), 1250);
eq('"1234" → 123400', money('1234'), 123400);
eq('"0" → 0', money('0'), 0);
eq('vazio → 0', money(''), 0);
eq('"12,5" → 1250', money('12,5'), 1250);
check('"abc" é rejeitado', !parseMoneyToCents('abc').ok);
check('negativo é rejeitado', !parseMoneyToCents('-5,00').ok);
// Arredondamento: 0.1+0.2 em float não pode virar 1 centavo a menos.
eq('"19,99" → 1999', money('19,99'), 1999);
eq('"0,07" → 7', money('0,07'), 7);

// ─────────── inteiros ───────────
const int = (s: string) => {
  const r = parseIntField(s, 'x');
  return r.ok ? r.value : `ERRO`;
};
eq('"5" → 5', int('5'), 5);
eq('"5,0" → 5', int('5,0'), 5);
eq('vazio → null', int(''), null);
check('"5,5" rejeitado (não é inteiro)', !parseIntField('5,5', 'x').ok);

// ─────────── cabeçalho ───────────
eq('"Preço Venda" → preco_venda', normalizeHeader('Preço Venda'), 'preco_venda');
eq('"DESCRIÇÃO" → descricao', normalizeHeader('DESCRIÇÃO'), 'descricao');
eq('" Código Barras " → codigo_barras', normalizeHeader(' Código Barras '), 'codigo_barras');

// ─────────── CSV com aspas ───────────
const quoted = parseCsv('a;b\r\n"tem ; ponto-e-virgula";"diz ""oi"""\r\n');
eq('campo entre aspas com ; preservado', quoted[1][0], 'tem ; ponto-e-virgula');
eq('aspas escapadas', quoted[1][1], 'diz "oi"');
const multiline = parseCsv('nome;descricao\r\n"Pão";"linha1\nlinha2"\r\n');
eq('quebra de linha dentro de aspas', multiline[1][1], 'linha1\nlinha2');
check('toCsv escapa ; e aspas', toCsv([['a;b', 'c"d']]).includes('"a;b";"c""d"'));
check('toCsv começa com BOM (Excel abre com acento certo)', toCsv([['ç']]).charCodeAt(0) === 0xfeff);

// ─────────── preview ───────────
const existing: ExistingProduct[] = [
  { id: 1, uuid: 'uuid-cafe-1', sku: 'CAF-001', barcode: '7891000315507' },
  { id: 2, uuid: 'uuid-pao-2', sku: 'PAO-001', barcode: null },
];
const cats = [{ id: 10, name: 'Mercearia' }];
// Aceita qualquer código: o dígito verificador tem teste próprio no shared/barcode.
const anyBarcode = () => true;

const base = (body: string) =>
  buildPreview({ csv: 'sku;codigo_barras;nome;categoria;preco_venda\r\n' + body, existing, existingCategories: cats, validateBarcode: anyBarcode });

{
  const r = base('NOVO-1;;Produto Novo;Mercearia;10,00\r\n');
  check('linha nova → status novo', r.ok && r.report.rows[0].status === 'novo');
  eq('preço convertido', r.ok && r.report.rows[0].data.priceCents, 1000);
}
{
  const r = base('CAF-001;;Café Renomeado;Mercearia;20,00\r\n');
  check('casou por SKU → atualizar', r.ok && r.report.rows[0].status === 'atualizar');
  eq('matchedBy = sku', r.ok && r.report.rows[0].matchedBy, 'sku');
  eq('matchedId = 1', r.ok && r.report.rows[0].matchedId, 1);
}
{
  const r = base(';7891000315507;Café;Mercearia;20,00\r\n');
  eq('código de barras tem prioridade sobre SKU no casamento', r.ok && r.report.rows[0].matchedBy, 'codigo_barras');
}
{
  // O caso que fazia ida-e-volta duplicar: produto sem SKU e sem código de barras.
  // O uuid do arquivo exportado é o que o identifica.
  const r = buildPreview({
    csv: 'uuid;nome;preco_venda\r\nuuid-pao-2;Pão;5,00\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  eq('casa por uuid quando não há SKU nem código de barras', r.ok && r.report.rows[0].matchedBy, 'uuid');
  eq('uuid casa com o produto certo', r.ok && r.report.rows[0].matchedId, 2);
  eq('→ atualiza, não duplica', r.ok && r.report.rows[0].status, 'atualizar');
}
{
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-cafe-1;CAF-001;Café\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  eq('uuid tem prioridade sobre tudo', r.ok && r.report.rows[0].matchedBy, 'uuid');
}
{
  // Arquivo de outra instalação: uuid desconhecido não pode travar nem casar errado.
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-que-nao-existe;CAF-001;Café\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  eq('uuid desconhecido cai no SKU', r.ok && r.report.rows[0].matchedBy, 'sku');
}
{
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-cafe-1;PAO-001;Confuso\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  check('uuid de um produto + SKU de outro vira conflito',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('conflito')), r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Duas linhas com o mesmo SKU: o índice único do banco estouraria no meio do INSERT.
  const r = base('DUP-1;;Um;Mercearia;1,00\r\nDUP-1;;Outro;Mercearia;2,00\r\n');
  check('SKU duplicado no arquivo vira erro', r.ok && r.report.rows[1].status === 'erro');
  check('erro aponta a linha da 1ª ocorrência', r.ok && r.report.rows[1].errors[0].includes('linha 2'), r.ok ? r.report.rows[1].errors[0] : '');
}
{
  const r = base(';;;Mercearia;1,00\r\n');
  check('nome vazio vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('nome')));
}
{
  // SKU de um produto + código de barras de outro: gravar violaria o único.
  const r = base('PAO-001;7891000315507;Confuso;Mercearia;1,00\r\n');
  check('conflito sku/código de barras de produtos diferentes vira erro',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('conflito')), r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  const r = buildPreview({
    csv: 'nome;categoria\r\nX;Bebidas\r\nY;Mercearia\r\nZ;bebidas\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  eq('categoria nova listada uma vez (case-insensitive)', r.ok && r.report.newCategories, ['Bebidas']);
}
{
  const r = buildPreview({
    csv: 'nome;codigo_barras\r\nX;123\r\n',
    existing, existingCategories: cats, validateBarcode: () => false,
  });
  check('código de barras com dígito inválido vira erro',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('dígito verificador')));
}
{
  // Estoque inicial em produto que já existe: saldo é do ledger, não se sobrescreve.
  const r = buildPreview({
    csv: 'sku;nome;estoque_inicial\r\nCAF-001;Café;50\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  check('estoque inicial em produto existente vira erro',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('estoque inicial só vale para produto novo')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Numeração precisa bater com o Excel mesmo com linha em branco no meio.
  const r = buildPreview({
    csv: 'sku;nome\r\nA-1;Um\r\n\r\nA-2;Dois\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode,
  });
  eq('linha em branco não é importada', r.ok && r.report.rows.length, 2);
  eq('numeração pula a linha em branco (Excel: 2 e 4)', r.ok && r.report.rows.map((x) => x.line), [2, 4]);
}
{
  const r = buildPreview({ csv: 'sku;preco_venda\r\nA;1,00\r\n', existing, existingCategories: cats, validateBarcode: anyBarcode });
  check('arquivo sem a coluna nome é rejeitado inteiro', !r.ok && r.error.includes('nome'));
}
{
  const r = buildPreview({ csv: 'nome\r\n', existing, existingCategories: cats, validateBarcode: anyBarcode });
  check('arquivo só com cabeçalho é rejeitado', !r.ok);
}
{
  const r = buildPreview({ csv: '', existing, existingCategories: cats, validateBarcode: anyBarcode });
  check('arquivo vazio é rejeitado', !r.ok);
}
{
  const r = base('N1;;Um;Mercearia;1,00\r\nCAF-001;;Dois;Mercearia;2,00\r\n;;;;\r\nX;;;Mercearia;3,00\r\n');
  check('totais batem', r.ok && r.report.totals.novos === 1 && r.report.totals.atualizar === 1 && r.report.totals.erros === 1,
    r.ok ? JSON.stringify(r.report.totals) : '');
}

// ─────────── o modelo tem que ser importável por ele mesmo ───────────
{
  const r = buildPreview({ csv: templateCsv(), existing: [], existingCategories: [], validateBarcode: anyBarcode });
  check('o modelo baixável passa no próprio validador', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.flatMap((x) => x.errors)) : (r as { error: string }).error);
  eq('modelo tem 2 exemplos', r.ok && r.report.rows.length, 2);
  eq('exemplo 1: preço 18,90 → 1890', r.ok && r.report.rows[0].data.priceCents, 1890);
  eq('exemplo 2 sem estoque inicial', r.ok && r.report.rows[1].data.initialStock, null);
}

console.log(failures ? `\n${failures} FALHA(S)` : '\nTodos os testes passaram.');
process.exit(failures ? 1 : 0);
