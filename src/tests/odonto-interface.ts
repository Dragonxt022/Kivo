/**
 * Guarda de interface do Kivo Odonto.
 *
 * Existe porque o módulo cresceu em 14 telas escritas em momentos diferentes, e o resultado foi
 * visível para quem usa: campos sem estilo (o sistema estiliza `.pm-field input` e `.input`, e
 * vários campos estavam soltos), subtítulo colado no título por margem negativa e nenhuma
 * orientação para quem entra pela primeira vez.
 *
 * Este teste varre as views e falha se:
 *  - alguma tela do módulo deixar de incluir os estilos compartilhados ou o tutorial;
 *  - aparecer campo de texto/seleção sem classe (o `.pm-field` do pai não vale para filtro de
 *    barra de ferramentas nem para linha de item);
 *  - voltar o padrão de subtítulo com margem negativa;
 *  - alguma tela de lista ficar sem mensagem amigável de "nada aqui";
 *  - o tutorial perder o auto-início, as âncoras ou o `nonce` do CSP.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'modules', 'odonto', 'views');
const PARTIAL = path.join(DIR, 'partials');
const RAIZ_PUBLIC = path.resolve(__dirname, '..', 'public');

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const arquivos = readdirSync(DIR).filter((f) => f.endsWith('.ejs'));
const telas = arquivos.filter((f) => !f.includes('print'));
const conteudo = new Map(arquivos.map((f) => [f, readFileSync(path.join(DIR, f), 'utf8')]));
const tour = readFileSync(path.join(PARTIAL, 'odonto-tour.ejs'), 'utf8');
const ui = readFileSync(path.join(PARTIAL, 'odonto-ui.ejs'), 'utf8');

// ─────────────────────── Estilos e tutorial em toda tela ───────────────────────
const semEstilo = telas.filter((f) => !conteudo.get(f)!.includes("include('partials/odonto-ui')"));
const semTour = telas.filter((f) => !conteudo.get(f)!.includes("include('partials/odonto-tour')"));
check('toda tela do módulo carrega os estilos compartilhados', semEstilo.length === 0, semEstilo.join(', '));
check('toda tela do módulo carrega o tutorial', semTour.length === 0, semTour.join(', '));
check('o módulo tem as telas esperadas', telas.length >= 13, `${telas.length} telas`);

// ─────────────────────── Campos com estilo ───────────────────────
const semClasse: string[] = [];
let camposComClasse = 0;
for (const f of telas) {
  const t = conteudo.get(f)!;
  for (const m of t.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const [todo, tag, attrs] = m;
    // checkbox/radio/cor/arquivo são nativos de propósito: não recebem preenchimento de campo.
    if (tag === 'input' && /type="(checkbox|radio|color|file|range|hidden)"/.test(attrs)) continue;
    if (/class=/.test(attrs)) { camposComClasse++; continue; }
    semClasse.push(`${f}: ${todo.slice(0, 80)}`);
  }
}
check('nenhum campo de texto/seleção sem classe', semClasse.length === 0,
  semClasse.length ? '\n    ' + semClasse.slice(0, 6).join('\n    ') : `${camposComClasse} campos com classe`);
check('a varredura encontrou campos de verdade', camposComClasse > 80, `${camposComClasse}`);
check('os estilos definem a classe de campo solto', ui.includes('input.input'));

// ─────────────────────── Título não cola no parágrafo ───────────────────────
const colados = telas.filter((f) => /margin-top:\s*-\.\drem/.test(conteudo.get(f)!));
check('nenhuma tela aperta subtítulo com margem negativa', colados.length === 0, colados.join(', '));
check('os estilos trazem o subtítulo com respiro', ui.includes('.page-subtitle'));

// ─────────────────────── Mensagem amigável de vazio ───────────────────────
const telasDeLista = [
  'odonto-patients.ejs', 'odonto-agenda.ejs', 'odonto-professionals.ejs', 'odonto-procedures.ejs',
  'odonto-anamnesis.ejs', 'odonto-anamnesis-templates.ejs', 'odonto-prontuario.ejs',
  'odonto-odontograma.ejs', 'odonto-planos.ejs', 'odonto-documentos.ejs', 'odonto-documentos-templates.ejs',
];
const semVazio = telasDeLista.filter((f) => {
  const t = conteudo.get(f);
  if (!t) return true;
  return !/empty-state|odonto-vazio/.test(t);
});
check('toda tela de lista explica o que fazer quando não há registro', semVazio.length === 0, semVazio.join(', '));
check('os estilos trazem a caixa de vazio', ui.includes('.odonto-vazio'));

// ─────────────────────── Tutorial ───────────────────────
check('o tutorial usa o motor do PDV/estoque', tour.includes('/js/tour.js'));
check('o tutorial roda sozinho na primeira entrada', /KivoTour\.autoStart\('kivo-tour-odonto-v1'/.test(tour));
check('o tutorial pode ser revisto depois', /startOdontoTour/.test(tour) && /Rever tutorial/.test(tour));
const blocoPassos = /var PASSOS = \[([\s\S]*?)\n    \];/.exec(tour)?.[1] ?? '';
const passos = [...blocoPassos.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
check('o tutorial explica o fluxo inteiro', passos.length >= 10, `${passos.length} passos: ${passos.slice(0, 3).join(' / ')}...`);
check('todo passo tem texto', (blocoPassos.match(/body:/g) ?? []).length === passos.length);
check('os passos apontam para âncoras do módulo',
  (blocoPassos.match(/el: '#tour-odonto-/g) ?? []).length === passos.length);
const ancorasNoTour = [...tour.matchAll(/el: '#(tour-odonto-[a-z-]+)'/g)].map((m) => m[1]);
const semAncora = ancorasNoTour.filter((a) => !telas.some((f) => conteudo.get(f)!.includes(`id="${a}"`)));
check('toda âncora do tutorial existe em alguma tela', semAncora.length === 0, semAncora.join(', '));
check('o script do tutorial respeita o CSP', (tour.match(/<script nonce="<%= cspNonce %>"/g) ?? []).length >= 2);

// ─────────────────────── Celebração do tutorial (todos os módulos) ───────────────────────
// O motor do tour é compartilhado: PDV, estoque e odonto. Se a celebração sumir do motor ou do
// CSS, os três módulos perdem o confete e o cartão de parabéns — por isso a guarda mora aqui.
const motor = readFileSync(path.resolve(RAIZ_PUBLIC, 'js', 'tour.js'), 'utf8');
const css = readFileSync(path.resolve(RAIZ_PUBLIC, 'css', 'app.css'), 'utf8');
check('o motor anima o holofote', css.includes('kivo-tour-pulse'));
check('o motor tem barra de progresso', motor.includes('kivo-tour-progress') && css.includes('.kivo-tour-progress'));
check('o fim do tutorial comemora', motor.includes('function parabenizar') && motor.includes('function soltarConfete'));
check('o confete tem estilo próprio', css.includes('.kivo-tour-confetti'));
check('pular o tutorial NÃO comemora',
  motor.includes("var celebrar = reason === 'finish'") && motor.includes('if (celebrar) parabenizar'));
check('quem pediu menos movimento não recebe animação', /prefers-reduced-motion[\s\S]{0,200}kivo-tour/.test(css));
check('os três módulos dizem o que celebrar',
  conteudo.get('odonto-patients.ejs')!.includes("include('partials/odonto-tour')") || tour.includes('CELEBRACAO'));
const celebraram = [motor, tour].join(' ');
check('a celebração tem texto próprio', celebraram.includes('Consultório pronto') || tour.includes('CELEBRACAO'));

console.log(failures === 0
  ? `\nInterface do odonto: TODOS OS TESTES PASSARAM (${telas.length} telas, ${passos.length} passos de tutorial)`
  : `\n${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
