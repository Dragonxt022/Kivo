import fs from 'node:fs';
import path from 'node:path';

/**
 * Base de conhecimento da KIVO IA.
 *
 * A IA de suporte responde a partir de duas fontes que já existem no produto:
 *  - a documentação técnica (`src/docs/dev/*.md`), a mesma servida em /admin/documentacao;
 *  - a wiki pública (`cloud/src/views/wiki.ejs`), o passo a passo ilustrado do cliente.
 *
 * Não há banco vetorial nem dependência nova: o corpus é pequeno e estável, então um índice
 * em memória com busca por termos (BM25 simplificado) resolve e continua offline. Os trechos
 * mais relevantes para a pergunta entram no prompt de sistema do modelo.
 *
 * O índice é reconstruído quando os arquivos mudam de data (ou a cada 10 min, como rede de
 * segurança) — em produção a documentação só muda em deploy.
 */

/** Botão de navegação sugerido no chat: leva o usuário direto para a tela do Kivo. */
export interface KnowledgeLink {
  label: string;
  route: string;
}

interface IndexedChunk {
  /** Rótulo legível da origem, exibido como fonte ("Wiki › Clientes"). */
  source: string;
  text: string;
  /** Tela do Kivo relacionada a este trecho (quando há uma). */
  link?: KnowledgeLink;
  /** Frequência de cada termo normalizado dentro do trecho. */
  terms: Map<string, number>;
  /** Comprimento em termos (para normalizar o BM25). */
  length: number;
}

interface KnowledgeIndex {
  chunks: IndexedChunk[];
  /** Frequência documental: em quantos trechos cada termo aparece. */
  df: Map<string, number>;
  builtAt: number;
  stamp: string;
}

const MAX_CHUNK_CHARS = 2200;
const CACHE_MS = 10 * 60 * 1000;

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'ao', 'aos', 'à', 'às', 'por', 'para', 'pra', 'com', 'sem', 'sob', 'sobre', 'e', 'ou', 'que', 'qual', 'quais',
  'como', 'quando', 'onde', 'porque', 'porquê', 'se', 'já', 'não', 'sim', 'é', 'são', 'ser', 'está', 'estão',
  'meu', 'minha', 'meus', 'minhas', 'seu', 'sua', 'seus', 'suas', 'isso', 'isto', 'aquilo', 'ele', 'ela',
  'eles', 'elas', 'eu', 'você', 'voce', 'nós', 'nos', 'the', 'of', 'to', 'and', 'or', 'is', 'are', 'a', 'an',
  'fazer', 'faço', 'faco', 'posso', 'consigo', 'quero', 'preciso', 'tem', 'ter', 'como',
]);

/**
 * De cada seção da wiki para a tela do app desktop. É o que permite a IA oferecer um botão
 * "Abrir Importar NF-e" quando a resposta veio daquela seção. Curado à mão: o id da seção
 * (wiki.ejs) e a rota (`/app/<módulo>/<página>`) não têm como ser inferidos.
 */
const WIKI_ROUTES: Record<string, KnowledgeLink> = {
  'boas-vindas': { label: 'Ir para o início', route: '/' },
  clientes: { label: 'Abrir Clientes', route: '/app/commercial/clientes' },
  fornecedores: { label: 'Abrir Fornecedores', route: '/app/commercial/fornecedores' },
  produtos: { label: 'Abrir Produtos', route: '/app/commercial/produtos' },
  categorias: { label: 'Abrir Categorias', route: '/app/commercial/categorias' },
  complementos: { label: 'Abrir Produtos', route: '/app/commercial/produtos' },
  estoque: { label: 'Abrir Estoque', route: '/app/commercial/lotes' },
  'listas-preco': { label: 'Abrir Listas de Preço', route: '/app/commercial/listas-de-preco' },
  compras: { label: 'Abrir Compras', route: '/app/commercial/compras' },
  'fiscal-notas': { label: 'Abrir Notas Fiscais', route: '/app/fiscal/notas' },
  'fiscal-config': { label: 'Abrir Configuração Fiscal', route: '/app/fiscal/configuracao' },
  'nfe-importar': { label: 'Abrir Importar NF-e', route: '/app/nfe/importar' },
  etiquetas: { label: 'Abrir Etiquetas', route: '/app/labels' },
  'etiquetas-historico': { label: 'Abrir Histórico de Etiquetas', route: '/app/labels/historico' },
  pdv: { label: 'Abrir PDV', route: '/app/store/pdv' },
  vendas: { label: 'Abrir Vendas', route: '/app/store/vendas' },
  orcamentos: { label: 'Abrir Orçamentos', route: '/app/store/orcamentos' },
  'mesas-comandas': { label: 'Abrir Mesas', route: '/app/comandas/mesas' },
  'modo-garcom': { label: 'Abrir Mesas', route: '/app/comandas/mesas' },
  'cozinha-kds': { label: 'Abrir Cozinha', route: '/app/foodservice/cozinha' },
  'roteamento-cozinha': { label: 'Abrir Roteamento', route: '/app/foodservice/roteamento' },
  'cardapio-online': { label: 'Abrir Cardápio Online', route: '/admin/configuracoes#cardapio' },
  usuarios: { label: 'Abrir Usuários', route: '/admin/usuarios' },
  notificacoes: { label: 'Abrir Central de Mensagens', route: '/notificacoes' },
  configuracoes: { label: 'Abrir Configurações', route: '/admin/configuracoes' },
  'rede-local': { label: 'Abrir Configurações › Rede', route: '/admin/configuracoes#rede' },
  backup: { label: 'Abrir Backup', route: '/admin/backup' },
  licenca: { label: 'Abrir Configurações › Licença', route: '/admin/configuracoes#license' },
};

/** De cada documento técnico (slug do .md) para a tela principal do módulo. */
const DOC_ROUTES: Record<string, KnowledgeLink> = {
  comercial: { label: 'Abrir Comercial', route: '/app/commercial/produtos' },
  estoque: { label: 'Abrir Estoque', route: '/app/commercial/lotes' },
  vendas: { label: 'Abrir PDV', route: '/app/store/pdv' },
  financeiro: { label: 'Abrir Financeiro', route: '/app/finance/caixa' },
  fiscal: { label: 'Abrir Fiscal', route: '/app/fiscal/notas' },
  comandas: { label: 'Abrir Mesas', route: '/app/comandas/mesas' },
  foodservice: { label: 'Abrir Cozinha', route: '/app/foodservice/cozinha' },
  etiquetas: { label: 'Abrir Etiquetas', route: '/app/labels' },
  dre: { label: 'Abrir DRE', route: '/app/dre/relatorio' },
  nfe: { label: 'Abrir Importar NF-e', route: '/app/nfe/importar' },
  painel: { label: 'Ir para o Painel', route: '/' },
};

/** Normaliza para comparação: minúsculas, sem acento, só alfanumérico. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…');
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Onde estão os .md: no monorepo (src/docs/dev) ou copiados no build (cloud/dist/docs/dev). */
function docsDir(): string | null {
  const candidates = [
    path.resolve(__dirname, 'docs', 'dev'), // prod: cloud/dist/docs/dev (copiado no build)
    path.resolve(__dirname, '..', 'docs', 'dev'), // cloud/docs/dev
    path.resolve(__dirname, '..', '..', 'src', 'docs', 'dev'), // monorepo: <raiz>/src/docs/dev
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

/** A view da wiki: em dev fica em cloud/src/views, no build em cloud/dist/views. */
function wikiFile(): string | null {
  const candidates = [
    path.resolve(__dirname, 'views', 'wiki.ejs'),
    path.resolve(__dirname, '..', 'src', 'views', 'wiki.ejs'),
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

function makeChunk(source: string, text: string, link?: KnowledgeLink): IndexedChunk | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 40) return null;
  const bounded = clean.length > MAX_CHUNK_CHARS ? `${clean.slice(0, MAX_CHUNK_CHARS)}…` : clean;
  const tokens = tokenize(bounded);
  if (!tokens.length) return null;
  const terms = new Map<string, number>();
  for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { source, text: bounded, link, terms, length: tokens.length };
}

function firstHeading(md: string): string | null {
  // Prefere o título mais específico: a wiki usa h2 (módulo) + h3 (funcionalidade).
  const m = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(md)
    ?? /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(md)
    ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(md)
    ?? /^#\s+(.+)$/m.exec(md);
  return m ? stripHtml(m[1]).trim() || null : null;
}

/** Cada `## ` do Markdown vira um trecho (o título do documento vira prefixo da origem). */
function chunksFromDevDocs(): IndexedChunk[] {
  const dir = docsDir();
  if (!dir) return [];
  const out: IndexedChunk[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const md = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const slug = file.replace(/\.md$/, '');
    const docTitle = (/^#\s+(.+)$/m.exec(md)?.[1] ?? slug).trim();
    const docLink = DOC_ROUTES[slug];
    const parts = md.split(/\n(?=##\s)/);
    for (const part of parts) {
      const heading = /^##\s+(.+)$/m.exec(part)?.[1]?.trim();
      const label = heading ? `Documentação › ${docTitle} › ${heading}` : `Documentação › ${docTitle}`;
      const chunk = makeChunk(label, part, docLink);
      if (chunk) out.push(chunk);
    }
  }
  return out;
}

/** Cada `<div class="wiki-section" id="...">` vira um trecho. */
function chunksFromWiki(): IndexedChunk[] {
  const file = wikiFile();
  if (!file) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const sections = raw.split(/<div class="wiki-section"\s+id="/).slice(1);
  const out: IndexedChunk[] = [];
  for (const section of sections) {
    const idEnd = section.indexOf('"');
    if (idEnd < 0) continue;
    const id = section.slice(0, idEnd);
    const heading = firstHeading(section) ?? id;
    const body = stripHtml(section);
    const chunk = makeChunk(`Wiki › ${heading}`, body, WIKI_ROUTES[id]);
    if (chunk) out.push(chunk);
  }
  return out;
}

let cached: KnowledgeIndex | null = null;

function fileStamp(): string {
  const parts: string[] = [];
  const dir = docsDir();
  if (dir) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      try { parts.push(`${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`); } catch { /* ignora */ }
    }
  }
  const wiki = wikiFile();
  if (wiki) {
    try { parts.push(`wiki:${fs.statSync(wiki).mtimeMs}`); } catch { /* ignora */ }
  }
  return parts.join('|');
}

function buildIndex(): KnowledgeIndex {
  const chunks = [...chunksFromDevDocs(), ...chunksFromWiki()];
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return { chunks, df, builtAt: Date.now(), stamp: fileStamp() };
}

function getIndex(): KnowledgeIndex {
  const stamp = fileStamp();
  if (cached && cached.stamp === stamp && Date.now() - cached.builtAt < CACHE_MS) return cached;
  cached = buildIndex();
  return cached;
}

export interface KnowledgeHit {
  source: string;
  text: string;
  score: number;
  link?: KnowledgeLink;
}

/**
 * Retorna os trechos mais relevantes para a pergunta. Vazio quando nada casa — aí o modelo
 * responde sem contexto, como antes.
 */
export function searchKnowledge(query: string, limit = 4): KnowledgeHit[] {
  const idx = getIndex();
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !idx.chunks.length) return [];

  const N = idx.chunks.length;
  const avgLen = idx.chunks.reduce((s, c) => s + c.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;
  const scored: KnowledgeHit[] = [];

  for (const chunk of idx.chunks) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.terms.get(term);
      if (!tf) continue;
      const df = idx.df.get(term) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.length / avgLen))));
      // Termo no rótulo da origem pesa mais (ex.: "clientes" na seção de Clientes).
      if (normalize(chunk.source).includes(term)) score += idf * 0.8;
    }
    if (score > 0) scored.push({ source: chunk.source, text: chunk.text, score, link: chunk.link });
  }

  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
}

/** Monta o bloco de contexto que entra no prompt de sistema. Vazio se nada foi encontrado. */
export function buildKnowledgeContext(query: string, limit = 4): { context: string; sources: string[]; links: KnowledgeLink[] } {
  const hits = searchKnowledge(query, limit);
  if (!hits.length) return { context: '', sources: [], links: [] };
  const context = hits.map((h) => `### ${h.source}\n${h.text}`).join('\n\n');
  // Botões de navegação: um por rota, na ordem de relevância dos trechos.
  const links: KnowledgeLink[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.link && !seen.has(h.link.route)) {
      seen.add(h.link.route);
      links.push(h.link);
    }
  }
  return { context, sources: hits.map((h) => h.source), links };
}

/** Só para testes/diagnóstico. */
export function knowledgeSize(): number {
  return getIndex().chunks.length;
}
