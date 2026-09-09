/**
 * Parser XML mínimo e sem dependência, focado em NF-e 4.00.
 *
 * Motivação: o Kivo é offline-first e não tem biblioteca XML (e não convém adicionar
 * uma dependência nativa só para importar nota). O que a NF-e precisa é um DOM leve com:
 *  - nomes de tag sem namespace (prefixos `nfe:` ignorados na comparação);
 *  - atributos (caso preservado; leitura é case-insensitive);
 *  - CDATA, comentários, prolog e DOCTYPE descartados;
 *  - decodificação das entidades básicas (&amp; &lt; &gt; &quot; &apos; e numéricas).
 *
 * Não é um parser XML genérico (não valida entidades DTD nem atributos duplicados) —
 * é o suficiente e o necessário para ler o que a SEFAZ envia. Entrada inválida lança
 * erro com mensagem, sem nunca aceitar documento corrompido.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Texto direto do nó (inclui CDATA), sem markup e sem os filhos. */
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0) return String.fromCodePoint(code);
      return m;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

function localName(name: string): string {
  const idx = name.indexOf(':');
  return idx < 0 ? name : name.slice(idx + 1);
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export function parseXml(input: string): XmlNode {
  let i = 0;
  const n = input.length;

  if (n === 0) throw new XmlParseError('XML vazio.');
  if (input.charCodeAt(0) === 0xfeff) i = 1;

  function fail(msg: string): never {
    const near = input.slice(Math.max(0, i - 20), i + 40).replace(/\s+/g, ' ').trim();
    throw new XmlParseError(`${msg} (perto de "${near}")`);
  }

  const isWs = (ch: string | undefined): boolean => ch != null && /\s/.test(ch);

  function readName(): string {
    const m = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(input.slice(i));
    if (!m) fail('nome de tag/atributo inválido');
    i += m[0].length;
    return m[0];
  }

  function readQuoted(): string {
    const quote = input[i];
    if (quote !== '"' && quote !== "'") fail('valor de atributo sem aspas');
    i++;
    const start = i;
    while (i < n && input[i] !== quote) i++;
    if (i >= n) fail('atributo não fechado');
    const raw = input.slice(start, i);
    i++;
    return decodeEntities(raw);
  }

  /** Pula prolog/comentário/DOCTYPE/CDATA avulso e espaços fora de elementos. */
  function skipOutside(): void {
    for (;;) {
      if (i >= n) return;
      const ch = input[i];
      if (ch === '<') {
        if (input.startsWith('<?', i)) {
          const e = input.indexOf('?>', i + 2);
          if (e < 0) fail('declaração XML não fechada');
          i = e + 2;
          continue;
        }
        if (input.startsWith('<!--', i)) {
          const e = input.indexOf('-->', i + 4);
          if (e < 0) fail('comentário não fechado');
          i = e + 3;
          continue;
        }
        if (input.startsWith('<!', i)) {
          const e = input.indexOf('>', i);
          if (e < 0) fail('DOCTYPE não fechado');
          i = e + 1;
          continue;
        }
        return;
      }
      if (isWs(ch)) { i++; continue; }
      fail('conteúdo inesperado fora dos elementos');
    }
  }

  function parseNode(): XmlNode {
    skipOutside();
    if (input[i] !== '<') fail('esperava abertura de elemento');
    i++;
    const rawTag = readName();
    const tag = localName(rawTag);
    const attrs: Record<string, string> = {};
    // Atributos (nome="valor" ou nome='valor').
    for (;;) {
      while (i < n && isWs(input[i])) i++;
      if (i >= n) fail('elemento não fechado');
      const ch = input[i];
      if (ch === '>') { i++; break; }
      if (ch === '/' && input[i + 1] === '>') { i += 2; return { tag, attrs, children: [], text: '' }; }
      if (ch === '<') fail('atributo esperado antes de novo elemento');
      const rawAttr = readName();
      while (i < n && isWs(input[i])) i++;
      if (input[i] !== '=') fail(`atributo "${rawAttr}" sem valor`);
      i++;
      while (i < n && isWs(input[i])) i++;
      attrs[rawAttr] = readQuoted();
    }

    const node: XmlNode = { tag, attrs, children: [], text: '' };
    // Conteúdo: texto/CDATA + filhos.
    let text = '';
    for (;;) {
      if (i >= n) fail(`elemento <${tag}> não fechado`);
      const ch = input[i];
      if (ch === '<') {
        if (input.startsWith('</', i)) {
          const closeStart = i + 2;
          const end = input.indexOf('>', closeStart);
          if (end < 0) fail('fechamento de elemento inválido');
          const closeRaw = input.slice(closeStart, end).trim();
          if (localName(closeRaw) !== tag) fail(`fechamento </${closeRaw}> não bate com <${tag}>`);
          i = end + 1;
          node.text = decodeEntities(text);
          return node;
        }
        if (input.startsWith('<!--', i)) {
          const e = input.indexOf('-->', i + 4);
          if (e < 0) fail('comentário não fechado');
          i = e + 3;
          continue;
        }
        if (input.startsWith('<![CDATA[', i)) {
          const e = input.indexOf(']]>', i + 9);
          if (e < 0) fail('CDATA não fechado');
          text += input.slice(i + 9, e);
          i = e + 3;
          continue;
        }
        if (input.startsWith('<?', i)) {
          const e = input.indexOf('?>', i + 2);
          if (e < 0) fail('instrução de processamento não fechada');
          i = e + 2;
          continue;
        }
        node.children.push(parseNode());
        continue;
      }
      text += ch;
      i++;
    }
  }

  skipOutside();
  const root = parseNode();
  skipOutside();
  return root;
}

/* ─── Helpers de leitura do DOM ─── */

export function xmlAttr(node: XmlNode | null | undefined, name: string): string | null {
  if (!node) return null;
  const want = name.toLowerCase();
  const found = Object.keys(node.attrs).find((k) => k.toLowerCase() === want);
  return found != null ? node.attrs[found] : null;
}

export function xmlChild(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  for (const c of node.children) if (c.tag === name) return c;
  return null;
}

export function xmlChildren(node: XmlNode | null | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.tag === name);
}

/** Primeiro nó com a tag dada em toda a árvore (busca em profundidade). */
export function findNode(node: XmlNode, name: string): XmlNode | null {
  if (node.tag === name) return node;
  for (const c of node.children) {
    const hit = findNode(c, name);
    if (hit) return hit;
  }
  return null;
}

/** Texto direto+descendentes do nó, com espaços normalizados. */
export function xmlText(node: XmlNode | null | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (nd: XmlNode): void => {
    if (nd.text) parts.push(nd.text);
    for (const c of nd.children) walk(c);
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function xmlChildText(node: XmlNode | null | undefined, name: string): string | null {
  const child = xmlChild(node, name);
  if (!child) return null;
  const t = xmlText(child);
  return t.length ? t : null;
}

/** Valor numérico em decimal (ponto como separador, como manda o leiaute da NF-e). */
export function xmlNumberText(node: XmlNode | null | undefined, name: string): number | null {
  const t = xmlChildText(node, name);
  if (t == null) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
