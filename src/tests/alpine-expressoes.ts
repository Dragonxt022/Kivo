/**
 * Guarda das expressões Alpine das views.
 *
 * Por que existe: o Alpine compila o valor de `x-text`, `:href`, `@click`… como código. Se uma
 * expressão estiver quebrada, o erro só aparece NO NAVEGADOR — e, quando ela está dentro de um
 * `<template x-for>`, só quando existir pelo menos uma linha na tabela. Foi assim que uma aspa
 * faltando no `:href` do anexo em `finance-bills.ejs` passou batido: com a lista vazia, nada
 * quebrava; com dados, a tela inteira do Contas a Receber lançava erro no console.
 *
 * Este teste varre todas as views, compila cada expressão (fora as que têm `<% %>` do EJS, que
 * só existem depois de renderizadas) e falha apontando arquivo e linha.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(__dirname, '..');
const ATRIBUTO = /(^|\s)(x-[a-z-]+|@[a-z.-]+|:[a-z-]+)\s*=\s*"([^"]*)"/g;

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function views(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const completo = path.join(dir, nome);
    if (statSync(completo).isDirectory()) views(completo, saida);
    else if (nome.endsWith('.ejs')) saida.push(completo);
  }
  return saida;
}

/** Compila como expressão e, se falhar, como corpo (vários `@click` têm instruções). */
function compila(expr: string): boolean {
  try {
    new Function(`return (${expr});`);
    return true;
  } catch {
    try {
      new Function(expr);
      return true;
    } catch {
      return false;
    }
  }
}

function main(): void {
  // O próprio verificador tem de pegar uma expressão quebrada (senão o teste passaria à toa).
  check('o verificador reconhece expressão quebrada', !compila("api + '/' + b.id + '/attachment"));
  check('o verificador aceita expressão boa', compila("api + '/' + b.id + '/attachment'"));

  const arquivos = views(path.join(RAIZ, 'views')).concat(views(path.join(RAIZ, 'modules')));
  const quebradas: string[] = [];
  let total = 0;
  let ignoradas = 0;

  for (const arquivo of arquivos) {
    const linhas = readFileSync(arquivo, 'utf8').split(/\r?\n/);
    linhas.forEach((linha, i) => {
      for (const m of linha.matchAll(ATRIBUTO)) {
        const expr = m[3];
        if (!expr.trim()) continue;
        // Expressões com EJS só existem depois de renderizadas: aqui não dá para compilar.
        if (expr.includes('<%')) { ignoradas++; continue; }
        total++;
        if (!compila(expr)) {
          quebradas.push(`${path.relative(RAIZ, arquivo)}:${i + 1}  ${m[2]}="${expr.slice(0, 100)}"`);
        }
      }
    });
  }

  check('encontrou as views do sistema', arquivos.length > 30, `${arquivos.length} view(s)`);
  check('verificou um número realista de expressões', total > 1000, `${total} expressão(ões)`);
  check('nenhuma expressão Alpine quebrada', quebradas.length === 0,
    quebradas.length ? '\n    ' + quebradas.join('\n    ') : `${total} verificadas, ${ignoradas} com EJS`);

  console.log(failures === 0
    ? `\nExpressões Alpine: TODOS OS TESTES PASSARAM (${total} expressões em ${arquivos.length} views)`
    : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
