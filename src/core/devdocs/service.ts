import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from './markdown';

/**
 * Documentação técnica interna (regras de negócio por módulo), servida em
 * /admin/documentacao apenas para quem tem `dev.docs.view` (por padrão, só o
 * Administrador).
 *
 * Os arquivos ficam em src/docs/dev/*.md — Markdown simples, versionado no repositório,
 * para ser lido tanto na tela quanto por agentes de IA/suporte direto no código. O build
 * copia a pasta para dist/docs/dev (ver scripts/copy-build-assets.js), então o caminho é
 * resolvido relativo a __dirname nos dois modos (dev e empacotado).
 */
const DOCS_DIR = path.resolve(__dirname, '..', '..', 'docs', 'dev');

export interface DevDocMeta {
  slug: string;
  title: string;
  summary: string | null;
}

export interface DevDoc extends DevDocMeta {
  html: string;
}

function titleOf(md: string, fallback: string): string {
  return (/^#\s+(.+)$/m.exec(md)?.[1] ?? fallback).trim();
}

/** Primeiro parágrafo (não título/lista/tabela) — usado como resumo no menu. */
function summaryOf(md: string): string | null {
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|') || line.startsWith('-') || line.startsWith('*')) continue;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return null;
}

export function listDevDocs(): DevDocMeta[] {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs.readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      const md = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
      return { slug, title: titleOf(md, slug), summary: summaryOf(md) };
    });
}

/** Renderiza um documento pelo slug. O slug é saneado (sem caminho) — nunca sai da pasta. */
export function renderDevDoc(slug: string): DevDoc | null {
  const safe = String(slug).replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return null;
  const file = path.join(DOCS_DIR, `${safe}.md`);
  if (!fs.existsSync(file)) return null;
  const md = fs.readFileSync(file, 'utf8');
  return { slug: safe, title: titleOf(md, safe), summary: summaryOf(md), html: renderMarkdown(md) };
}
