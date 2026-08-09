/**
 * Testes do parser/validador de importação de produtos (productsImport.ts).
 * Lógica pura — não abre banco nem sobe servidor, então roda em milissegundos.
 */
import {
  parseCsv, toCsv, parseMoneyToCents, parseIntField, normalizeHeader,
  buildPreview, templateCsv, parseTipo, parseAttributes, parseRefList, parseGroupList,
  parseBoolField, type ExistingProduct, type AttributePart,
} from '../modules/commercial/productsImport';
import { buildComplementsPreview, complementsTemplateCsv } from '../modules/commercial/complementsImport';

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
  { id: 1, uuid: 'uuid-cafe-1', sku: 'CAF-001', barcode: '7891000315507', name: 'Café Torrado', productType: 'fisico' },
  { id: 2, uuid: 'uuid-pao-2', sku: 'PAO-001', barcode: null, name: 'Pão Francês', productType: 'fisico' },
  // Dois produtos com o mesmo nome, de propósito: é o que faz a resolução por nome
  // recusar em vez de escolher um deles.
  { id: 3, uuid: 'uuid-agua-3', sku: 'AGU-500', barcode: null, name: 'Água', productType: 'fisico' },
  { id: 4, uuid: 'uuid-agua-4', sku: 'AGU-1500', barcode: null, name: 'Água', productType: 'fisico' },
];
const cats = [{ id: 10, name: 'Mercearia' }];
// Aceita qualquer código: o dígito verificador tem teste próprio no shared/barcode.
const anyBarcode = () => true;
const cap = { variantes: true, complementos: true };

const base = (body: string) =>
  buildPreview({ csv: 'sku;codigo_barras;nome;categoria;preco_venda\r\n' + body, existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap });

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
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  eq('casa por uuid quando não há SKU nem código de barras', r.ok && r.report.rows[0].matchedBy, 'uuid');
  eq('uuid casa com o produto certo', r.ok && r.report.rows[0].matchedId, 2);
  eq('→ atualiza, não duplica', r.ok && r.report.rows[0].status, 'atualizar');
}
{
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-cafe-1;CAF-001;Café\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  eq('uuid tem prioridade sobre tudo', r.ok && r.report.rows[0].matchedBy, 'uuid');
}
{
  // Arquivo de outra instalação: uuid desconhecido não pode travar nem casar errado.
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-que-nao-existe;CAF-001;Café\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  eq('uuid desconhecido cai no SKU', r.ok && r.report.rows[0].matchedBy, 'sku');
}
{
  const r = buildPreview({
    csv: 'uuid;sku;nome\r\nuuid-cafe-1;PAO-001;Confuso\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
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
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  eq('categoria nova listada uma vez (case-insensitive)', r.ok && r.report.newCategories, ['Bebidas']);
}
{
  const r = buildPreview({
    csv: 'nome;codigo_barras\r\nX;123\r\n',
    existing, existingCategories: cats, validateBarcode: () => false, capabilities: cap,
  });
  check('código de barras com dígito inválido vira erro',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('dígito verificador')));
}
{
  // Estoque inicial em produto que já existe: saldo é do ledger, não se sobrescreve.
  const r = buildPreview({
    csv: 'sku;nome;estoque_inicial\r\nCAF-001;Café;50\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  check('estoque inicial em produto existente vira erro',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('estoque inicial só vale para produto novo')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Numeração precisa bater com o Excel mesmo com linha em branco no meio.
  const r = buildPreview({
    csv: 'sku;nome\r\nA-1;Um\r\n\r\nA-2;Dois\r\n',
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });
  eq('linha em branco não é importada', r.ok && r.report.rows.length, 2);
  eq('numeração pula a linha em branco (Excel: 2 e 4)', r.ok && r.report.rows.map((x) => x.line), [2, 4]);
}
{
  const r = buildPreview({ csv: 'sku;preco_venda\r\nA;1,00\r\n', existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap });
  check('arquivo sem a coluna nome é rejeitado inteiro', !r.ok && r.error.includes('nome'));
}
{
  const r = buildPreview({ csv: 'nome\r\n', existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap });
  check('arquivo só com cabeçalho é rejeitado', !r.ok);
}
{
  const r = buildPreview({ csv: '', existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap });
  check('arquivo vazio é rejeitado', !r.ok);
}
{
  const r = base('N1;;Um;Mercearia;1,00\r\nCAF-001;;Dois;Mercearia;2,00\r\n;;;;\r\nX;;;Mercearia;3,00\r\n');
  check('totais batem', r.ok && r.report.totals.novos === 1 && r.report.totals.atualizar === 1 && r.report.totals.erros === 1,
    r.ok ? JSON.stringify(r.report.totals) : '');
}

// ─────────── colunas fiscais (NCM/CEST/CSOSN/CST/origem) ───────────
{
  const fiscal = (body: string) =>
    buildPreview({
      csv: 'nome;preco_venda;ncm;cest;csosn;cst;origem\r\n' + body,
      existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
    });

  const ok = fiscal('Refrigerante;5,00;2202.10.00;28.038.00;102;;0\r\n');
  check('linha fiscal válida sem erro', ok.ok && ok.report.rows[0].errors.length === 0,
    ok.ok ? JSON.stringify(ok.report.rows[0].errors) : '');
  eq('NCM guardado só com dígitos', ok.ok && ok.report.rows[0].data.ncm, '22021000');
  eq('CEST guardado só com dígitos', ok.ok && ok.report.rows[0].data.cest, '2803800');
  eq('CSOSN preservado', ok.ok && ok.report.rows[0].data.csosn, '102');
  eq('origem convertida para número', ok.ok && ok.report.rows[0].data.origem, 0);

  const semFiscal = fiscal('Sem fiscal;5,00;;;;;\r\n');
  check('campos fiscais em branco viram null (não apagam cadastro no update)',
    semFiscal.ok && semFiscal.report.rows[0].data.ncm === null && semFiscal.report.rows[0].data.origem === null);

  const ncmCurto = fiscal('NCM curto;5,00;2202;;;;\r\n');
  check('NCM com menos de 8 dígitos vira erro',
    ncmCurto.ok && ncmCurto.report.rows[0].errors.some((e) => e.includes('NCM')),
    ncmCurto.ok ? JSON.stringify(ncmCurto.report.rows[0].errors) : '');

  const cestCurto = fiscal('CEST curto;5,00;22021000;123;;;\r\n');
  check('CEST com menos de 7 dígitos vira erro',
    cestCurto.ok && cestCurto.report.rows[0].errors.some((e) => e.includes('CEST')));

  const origemRuim = fiscal('Origem inválida;5,00;22021000;;;;9\r\n');
  check('origem fora de 0–8 vira erro',
    origemRuim.ok && origemRuim.report.rows[0].errors.some((e) => e.includes('origem')));
}

// ─────────── o modelo tem que ser importável por ele mesmo ───────────
{
  const r = buildPreview({ csv: templateCsv(), existing: [], existingCategories: [], validateBarcode: anyBarcode, capabilities: cap });
  check('o modelo baixável passa no próprio validador', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.flatMap((x) => x.errors)) : (r as { error: string }).error);
  eq('modelo tem 5 exemplos (fisico, kit, variante mestre + filha)', r.ok && r.report.rows.length, 5);
  eq('exemplo 1: preço 18,90 → 1890', r.ok && r.report.rows[0].data.priceCents, 1890);
  eq('exemplo 3 (kit) resolve os 2 componentes', r.ok && r.report.rows[2].data.kitItems.length, 2);
  eq('exemplo 4 é variante mestre', r.ok && r.report.rows[3].data.productType, 'variante');
  eq('exemplo 5 (filha) aponta o pai por SKU', r.ok && r.report.rows[4].data.parentRef, 'CAM-001');
  eq('exemplo 5: atributos Tamanho=P', r.ok && r.report.rows[4].data.attributes, [{ name: 'Tamanho', value: 'P' }]);
}

// ─────────── v2: parsers de tipo/atributos/refs ───────────
{
  eq('tipo vazio → fisico', parseTipo('') && parseTipo('').ok && (parseTipo('') as { value: string }).value, 'fisico');
  eq('tipo "Kit" → kit', parseTipo('Kit') && parseTipo('Kit').ok && (parseTipo('Kit') as { value: string }).value, 'kit');
  check('tipo inválido rejeitado', !parseTipo('combo-luxo').ok);
  check('tipo "PIZZA" rejeitado', !parseTipo('pizza').ok);

  const a = parseAttributes('Tamanho=M|Cor=Azul');
  eq('atributos pares', a.ok && a.value, [{ name: 'Tamanho', value: 'M' }, { name: 'Cor', value: 'Azul' }]);
  const aBare = parseAttributes('Tamanho|Cor');
  eq('atributos só nome (mestre)', aBare.ok && aBare.value, [{ name: 'Tamanho', value: null }, { name: 'Cor', value: null }]);
  check('atributo sem valor rejeitado', !parseAttributes('Tamanho=').ok);
  check('atributo repetido rejeitado', !parseAttributes('Cor=Azul|Cor=Verde').ok);
  check('atributos vazios → []', parseAttributes('').ok && (parseAttributes('') as { value: AttributePart[] }).value.length === 0);

  const r = parseRefList('CAF-001*1|PAO-001*2', 'componentes');
  eq('refs com qtd', r.ok && r.value, [{ ref: 'CAF-001', qty: 1 }, { ref: 'PAO-001', qty: 2 }]);
  const r2 = parseRefList('FAR-01*0,5', 'ficha técnica');
  eq('qtd com vírgula decimal (0,5)', r2.ok && r2.value, [{ ref: 'FAR-01', qty: 0.5 }]);
  const r3 = parseRefList('CAF-001', 'componentes');
  eq('ref sem qtd vale 1', r3.ok && r3.value, [{ ref: 'CAF-001', qty: 1 }]);
  check('qtd zero rejeitada', !parseRefList('CAF-001*0', 'componentes').ok);
  check('ref vazia rejeitada', !parseRefList('*1', 'componentes').ok);

  eq('grupos: "Bordas| Molhos" → 2', parseGroupList('Bordas| Molhos'), ['Bordas', 'Molhos']);
  eq('grupos vazios → []', parseGroupList(''), []);

  eq('controla_estoque "nao" → false', parseBoolField('nao', 'x').ok && (parseBoolField('nao', 'x') as { value: boolean | null }).value, false);
  eq('visivel_cardapio "sim" → true', parseBoolField('sim', 'x').ok && (parseBoolField('sim', 'x') as { value: boolean | null }).value, true);
  eq('vazio → null (usar padrão)', parseBoolField('', 'x').ok && (parseBoolField('', 'x') as { value: boolean | null }).value, null);
  check('bool inválido rejeitado', !parseBoolField('talvez', 'x').ok);
}

// ─────────── v2: referências cruzadas e validações de tipo ───────────
// Linhas montadas por array (join(';')) para não errar contagem de coluna.
const v2rows = (rows: (string | number)[][]) =>
  'sku;nome;tipo;produto_pai;atributos;componentes;ficha_tecnica;grupos_complemento\r\n' +
  rows.map((r) => r.join(';')).join('\r\n') + '\r\n';
const v2 = (rows: (string | number)[][]) =>
  buildPreview({
    csv: v2rows(rows),
    existing, existingCategories: cats, validateBarcode: anyBarcode, capabilities: cap,
  });

{
  const r = v2([
    ['CAM-001', 'Camisa', 'variante', '', 'Tamanho|Cor'],
    ['CAM-001-P', 'Camisa P', 'variante', 'CAM-001', 'Tamanho=P'],
  ]);
  check('variante mestre + filha sem erro', r.ok && r.report.rows.every((x) => x.status === 'novo'),
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
  eq('tipo do mestre é variante', r.ok && r.report.rows[0].data.productType, 'variante');
  eq('filha aponta o pai por SKU', r.ok && r.report.rows[1].data.parentRef, 'CAM-001');
}
{
  const r = v2([['CAM-001-P', 'Camisa P', 'variante', '', 'Tamanho=P']]);
  check('variante sem produto_pai é o mestre — sem erro', r.ok && r.report.rows[0].errors.length === 0,
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
  eq('mestre não tem pai', r.ok && r.report.rows[0].data.parentRef, null);
}
{
  // Filha referenciando pai que o próprio arquivo cria, com pai DEPOIS da filha.
  const r = v2([
    ['CAM-001-P', 'Camisa P', 'variante', 'CAM-001', 'Tamanho=P'],
    ['CAM-001', 'Camisa', 'variante', '', 'Tamanho|Cor'],
  ]);
  check('pai resolvido mesmo vindo depois (ordem não importa)', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  const r = v2([
    ['FAR-01', 'Farofa', 'fisico'],
    ['X', 'X Produzido', 'produzido', '', '', '', 'FAR-01*1'],
  ]);
  check('produzido com insumo fisico do arquivo sem erro', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  const r = v2([['KIT-01', 'Kit Café', 'kit', '', '', 'CAF-001*1|PAO-001*2']]);
  check('kit com componentes do banco sem erro', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
  const vazio = v2([['KIT-01', 'Kit Vazio', 'kit']]);
  check('kit sem componentes vira erro', vazio.ok && vazio.report.rows[0].errors.some((e) => e.includes('componente')));
}
{
  const r = v2([
    ['KIT-01', 'Kit', 'kit', '', '', 'KIT-02*1'],
    ['KIT-02', 'Kit2', 'kit'],
  ]);
  check('kit dentro de kit vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('kit dentro de kit')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Planilha montada à mão quase nunca tem SKU: quem digita escreve o NOME do pai.
  // Sem a resolução por nome, um arquivo assim vinha inteiro vermelho.
  const r = v2([
    ['', 'Poltrona (1 Lugar)', 'variante', '', 'Nível de Sujeira'],
    ['', 'Poltrona (1 Lugar) - Leve', 'variante', 'Poltrona (1 Lugar)', 'Nível de Sujeira=Leve'],
    ['', 'Poltrona (1 Lugar) - Pesada', 'variante', 'Poltrona (1 Lugar)', 'Nível de Sujeira=Pesada'],
  ]);
  check('produto_pai por NOME resolve dentro do arquivo (sem SKU)', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  // Nome vale também contra o catálogo já cadastrado, não só contra o arquivo.
  const r = v2([['KIT-01', 'Kit Café', 'kit', '', '', 'Café Torrado*1|Pão Francês*2']]);
  check('componentes por NOME resolvem contra o catálogo', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  // Dois produtos "Água" no catálogo: escolher um seria ligar o kit ao errado em silêncio.
  const r = v2([['KIT-01', 'Kit', 'kit', '', '', 'Água*1']]);
  check('nome ambíguo no catálogo vira erro, não escolhe sozinho',
    r.ok && r.report.rows[0].errors.some((e) => e.includes('produtos com esse nome')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Ambiguidade dentro do próprio arquivo segue a mesma regra.
  const r = v2([
    ['A-1', 'Refrigerante', 'fisico'],
    ['A-2', 'Refrigerante', 'fisico'],
    ['KIT-01', 'Kit', 'kit', '', '', 'Refrigerante*1'],
  ]);
  check('nome ambíguo dentro do arquivo vira erro',
    r.ok && r.report.rows[2].errors.some((e) => e.includes('produtos com esse nome')),
    r.ok ? JSON.stringify(r.report.rows[2].errors) : '');
}
{
  // SKU tem precedência sobre nome: um produto chamado "CAF-001" não pode sequestrar
  // a referência que aponta para o SKU CAF-001.
  const r = v2([
    ['ZZZ-9', 'CAF-001', 'fisico'],
    ['KIT-01', 'Kit', 'kit', '', '', 'CAF-001*1'],
  ]);
  const kitRef = r.ok ? r.report.rows[1].data.kitItems[0].ref : '';
  check('SKU tem precedência sobre nome na referência', r.ok && r.report.totals.erros === 0 && kitRef === 'CAF-001',
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  // Kit referenciando produto que não existe em lugar nenhum.
  const r = v2([['KIT-01', 'Kit', 'kit', '', '', 'NAO-EXISTE*1']]);
  check('componente inexistente vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('não encontrado')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Produzido consumindo outro produzido do arquivo que se consome de volta.
  const r = v2([
    ['PROD-A', 'A', 'produzido', '', '', '', 'PROD-B*1'],
    ['PROD-B', 'B', 'produzido', '', '', '', 'PROD-A*1'],
  ]);
  check('ciclo em ficha técnica vira erro', r.ok && r.report.rows.some((x) => x.errors.some((e) => e.includes('ciclo'))),
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  // Produzido consumindo um kit (proibido no CRUD).
  const r = v2([
    ['KIT-01', 'Kit', 'kit', '', '', 'CAF-001*1'],
    ['PROD-A', 'A', 'produzido', '', '', '', 'KIT-01*1'],
  ]);
  check('produzido com insumo kit vira erro', r.ok && r.report.rows[1].errors.some((e) => e.includes('não pode ser kit')),
    r.ok ? JSON.stringify(r.report.rows[1].errors) : '');
}
{
  const r = v2([['PAO-001', 'Pão', 'fisico', 'CAF-001']]);
  check('produto_pai em linha não-variante vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('só vale para')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  const r = v2([['X', 'Produto', 'fisico', '', '', '', '', 'Bordas|Molhos']]);
  check('grupos de complemento são listados', !!(r.ok && r.report.rows[0].data.complementGroups.length === 2), String(r.ok && r.report.rows[0].data.complementGroups));
}
{
  // Capability variantes desligada → linha variante vira erro.
  const r = buildPreview({
    csv: 'sku;nome;tipo;produto_pai\r\nCAM-001;Camisa;variante;\r\n',
    existing: [], existingCategories: [], validateBarcode: anyBarcode,
    capabilities: { variantes: false, complementos: true },
  });
  check('variante com capability desligada vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('commercial.variantes')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  const r = buildPreview({
    csv: 'sku;nome;tipo;grupos_complemento\r\nX;Produto;fisico;Bordas\r\n',
    existing: [], existingCategories: [], validateBarcode: anyBarcode,
    capabilities: { variantes: true, complementos: false },
  });
  check('grupo de complemento com capability desligada vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('commercial.complementos')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  // Estoque inicial em filha de variante existente continua bloqueado.
  const r = v2([['CAF-001', 'Café', 'fisico']]);
  eq('update por SKU continua funcionando com colunas novas', r.ok && r.report.rows[0].status, 'atualizar');
}

// ─────────── complementos (complementsImport.ts) ───────────
{
  const tpl = buildComplementsPreview({
    csv: complementsTemplateCsv(),
    existingGroups: [],
    resolveProduct: (sku) => ({ productId: sku === 'CAF-001' ? 1 : 2 }),
    pendingSkus: [],
  });
  check('modelo de complementos passa no próprio validador', tpl.ok && tpl.report.totals.erros === 0,
    tpl.ok ? JSON.stringify(tpl.report.rows.flatMap((x) => x.errors)) : '');
  eq('3 opções no modelo', tpl.ok && tpl.report.totals.total, 3);
  eq('2 grupos no modelo', tpl.ok && tpl.report.groups.length, 2);
}
{
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku;preco_opcao;ordem\r\n' +
         'Bordas;0;2;CAF-001;5,00;1\r\nBordas;0;2;PAO-001;;2\r\n',
    existingGroups: [],
    resolveProduct: () => ({ productId: 1 }),
    pendingSkus: [],
  });
  check('grupo novo com 2 opções sem erro', r.ok && r.report.totals.erros === 0 && r.report.groups.length === 1,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
  check('preço vazio → sem preço próprio', r.ok && r.report.rows[1].data.priceOverrideCents === null);
  eq('preço 5,00 → 500', r.ok && r.report.rows[0].data.priceOverrideCents, 500);
}
{
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku\r\nBordas;3;2;CAF-001\r\n',
    existingGroups: [],
    resolveProduct: () => ({ productId: 1 }),
    pendingSkus: [],
  });
  check('min > max vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('maior que')),
    r.ok ? JSON.stringify(r.report.rows[0].errors) : '');
}
{
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku\r\nBordas;0;2;NAO-EXISTE\r\n',
    existingGroups: [],
    resolveProduct: () => undefined,
    pendingSkus: [],
  });
  check('opção inexistente vira erro', r.ok && r.report.rows[0].errors.some((e) => e.includes('não encontrada')));
}
{
  // Opção que o arquivo de produtos (etapa 1) vai criar conta como resolvida.
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku\r\nBordas;0;2;NOVO-001\r\n',
    existingGroups: [],
    resolveProduct: () => undefined,
    pendingSkus: ['NOVO-001'],
  });
  check('opção pendente (produtos.csv) não vira erro', r.ok && r.report.totals.erros === 0,
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku\r\nBordas;0;2;CAF-001\r\nBordas;1;2;PAO-001\r\n',
    existingGroups: [],
    resolveProduct: () => ({ productId: 1 }),
    pendingSkus: [],
  });
  check('min/max divergente entre linhas do mesmo grupo vira erro',
    r.ok && r.report.rows[1].errors.some((e) => e.includes('divergem')),
    r.ok ? JSON.stringify(r.report.rows.map((x) => x.errors)) : '');
}
{
  // Atualização: grupo existente + opção existente → atualizar.
  const r = buildComplementsPreview({
    csv: 'grupo;min_selecao;max_selecao;opcao_sku\r\nBordas;0;2;CAF-001\r\n',
    existingGroups: [{
      id: 7, name: 'Bordas', minSelect: 0, maxSelect: 2,
      items: [{ id: 9, productId: 1, productSku: 'CAF-001', priceOverrideCents: null, sortOrder: 1 }],
    }],
    resolveProduct: () => ({ productId: 1 }),
    pendingSkus: [],
  });
  check('grupo existente → grupoId preenchido', r.ok && r.report.rows[0].groupId === 7);
  check('opção existente → itemId preenchido e status atualizar', r.ok && r.report.rows[0].itemId === 9 && r.report.rows[0].status === 'atualizar');
}

console.log(failures ? `\n${failures} FALHA(S)` : '\nTodos os testes passaram.');
process.exit(failures ? 1 : 0);
