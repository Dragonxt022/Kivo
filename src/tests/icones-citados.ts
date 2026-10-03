/**
 * Guarda dos ícones citados pelos módulos.
 *
 * O Kivo resolve ícone por NOME DE ARQUIVO em `public/icons` (ver `core/icons/service.ts`). Se um
 * manifesto ou uma view cita um ícone que não existe, `svgIcon()` cai no conjunto padrão e a tela
 * mostra um ícone genérico — ou o mesmo ícone em vários lugares — sem erro nenhum no console.
 *
 * Foi assim que a Agenda ficou com o ícone errado: `icon: 'calendar'` e nenhum `calendar.svg`.
 * Este teste cruza o que os módulos citam com o que existe no pacote.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(__dirname, '..');
const ICONES = path.resolve(RAIZ, 'public', 'icons');

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function arquivos(dir: string, filtro: (n: string) => boolean, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const completo = path.join(dir, nome);
    if (statSync(completo).isDirectory()) arquivos(completo, filtro, saida);
    else if (filtro(nome)) saida.push(completo);
  }
  return saida;
}

const existentes = new Set(readdirSync(ICONES).filter((n) => n.endsWith('.svg')).map((n) => n.replace(/\.svg$/, '')));

// Ícones citados em manifesto (`icon: 'x'`) e em view (`svgIcon('x')`).
const fontes = [
  ...arquivos(path.join(RAIZ, 'modules'), (n) => n === 'module.manifest.ts'),
  ...arquivos(path.join(RAIZ, 'modules'), (n) => n.endsWith('.ejs')),
  ...arquivos(path.join(RAIZ, 'views'), (n) => n.endsWith('.ejs')),
];
const citados = new Map<string, string>();
for (const arquivo of fontes) {
  const texto = readFileSync(arquivo, 'utf8');
  for (const m of texto.matchAll(/icon:\s*'([a-z0-9-]+)'/g)) citados.set(m[1], arquivo);
  for (const m of texto.matchAll(/svgIcon\(\s*'([a-z0-9-]+)'/g)) citados.set(m[1], arquivo);
}

const faltando = [...citados.keys()].filter((nome) => !existentes.has(nome))
  .map((nome) => `${nome} (${path.relative(RAIZ, citados.get(nome)!)})`);

check('o pacote de ícones padrão tem arquivos', existentes.size >= 30, `${existentes.size} ícones`);
check('encontrou os ícones citados pelo sistema', citados.size >= 15, `${citados.size} nomes citados`);
check('todo ícone citado existe no pacote', faltando.length === 0, faltando.join(' | '));
check('o ícone da agenda existe (era o que faltava)', existentes.has('calendar'));
check('os ícones continuam no formato inline (currentColor)',
  readFileSync(path.join(ICONES, 'calendar.svg'), 'utf8').includes('currentColor')
  && readFileSync(path.join(ICONES, 'calendar.svg'), 'utf8').includes('viewBox="0 0 24 24"'));

console.log(failures === 0
  ? `\nÍcones citados: TODOS OS TESTES PASSARAM (${citados.size} citados, ${existentes.size} no pacote)`
  : `\n${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
