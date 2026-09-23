/**
 * Documentação técnica (regras de negócio por módulo) servida no painel do Kivo Cloud,
 * em /admin/documentacao. É o mesmo conteúdo Markdown do app local (`src/docs/dev/*.md`),
 * para suporte e treinamento de agentes de IA.
 *
 * O renderizador é uma cópia mínima (sem dependência) do que existe no app local — os dois
 * projetos têm `rootDir` próprio e não compartilham código de build. O conteúdo, porém, é
 * a MESMA fonte: a pasta `src/docs/dev` do repositório.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Onde procurar os .md: no monorepo (src/docs/dev) ou copiados no build (dist/docs/dev). */
function docsDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'docs', 'dev'), // prod: cloud/dist/docs/dev (copiado no build)
    path.resolve(__dirname, '..', '..', 'src', 'docs', 'dev'), // monorepo: <raiz>/src/docs/dev
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

export interface DevDocMeta {
  slug: string;
  title: string;
  summary: string | null;
}

export interface DevDoc extends DevDocMeta {
  html: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(md: string): string {
  let s = escapeHtml(md);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('|');
}

const BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s)/;

function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inline(heading[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
      out.push(
        '<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>',
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push('<ul>' + buf.map((b) => `<li>${inline(b)}</li>`).join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol>' + buf.map((b) => `<li>${inline(b)}</li>`).join('') + '</ol>');
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

function titleOf(md: string, fallback: string): string {
  return (/^#\s+(.+)$/m.exec(md)?.[1] ?? fallback).trim();
}

function summaryOf(md: string): string | null {
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|') || line.startsWith('-') || line.startsWith('*')) continue;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return null;
}

export function listDevDocs(): DevDocMeta[] {
  const dir = docsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      const md = fs.readFileSync(path.join(dir, f), 'utf8');
      return { slug, title: titleOf(md, slug), summary: summaryOf(md) };
    });
}

/** Renderiza um documento pelo slug. O slug é saneado (sem caminho) — nunca sai da pasta. */
export function renderDevDoc(slug: string): DevDoc | null {
  const safe = String(slug).replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return null;
  const file = path.join(docsDir(), `${safe}.md`);
  if (!fs.existsSync(file)) return null;
  const md = fs.readFileSync(file, 'utf8');
  return { slug: safe, title: titleOf(md, safe), summary: summaryOf(md), html: renderMarkdown(md) };
}
