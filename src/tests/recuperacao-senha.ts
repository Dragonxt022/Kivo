/**
 * Resgate de senha por código de desafio/resposta, pelas ROTAS — o caminho que a tela de
 * login percorre de verdade.
 *
 * Cobre também duas coisas que não são "o fluxo feliz" e que já falharam na prática:
 *  - o gêmeo `cloud/src/recoveryCodes.ts` produzindo o MESMO código que o desktop verifica
 *    (são deploys separados; divergir significa suporte ditando código que não funciona);
 *  - `x-data="…"` nas views sem aspa dupla solta no meio — foi assim que o nav inteiro
 *    virou texto cru na tela do lojista.
 *
 * KIVO_DB_PATH TEM que vir do ambiente (`import` é hoisted e connection.ts lê a variável
 * antes deste arquivo rodar):
 *   node scripts/kivo test:recuperacao-senha    ← use o comando
 */
import fs from 'node:fs';
import path from 'node:path';

import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { activateTestLicense } from './resetTestDb';
import { setSecret, deleteSecret, secretsFilePath } from '../core/secrets/service';
import { RECOVERY_SECRET_KEY } from '../core/license/service';
import { verifyPassword } from '../core/auth/service';
import { expectedResponse, normalize } from '../core/recovery/codes';
import { completeRecovery } from '../core/recovery/service';

/**
 * O gêmeo do cloud entra por `require` em tempo de execução, e não por `import`.
 *
 * `import` faria o TypeScript puxar `cloud/src/` para dentro do programa do desktop, que
 * tem `rootDir: src` — o teste rodaria bem no `tsx` e o `npm run build` quebraria com
 * TS6059. Com `require`, o `tsc` vê só uma chamada de função e o `tsx` resolve o `.ts`
 * normalmente na hora de rodar.
 *
 * Vale o incômodo: são dois deploys separados, e se os dois lados divergirem o suporte
 * passa a ditar código que não funciona — falha que só apareceria com o cliente na linha.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloudCodes = require('../../cloud/src/recoveryCodes') as {
  expectedResponse(secret: string, challenge: string): string;
};
const cloudExpectedResponse = cloudCodes.expectedResponse;

const PORT = Number(process.env.KIVO_PORT ?? 3719);
const base = `http://localhost:${PORT}`;
const SEGREDO = 'a'.repeat(64);
let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertBancoDescartavel(): string {
  const alvo = process.env.KIVO_DB_PATH;
  if (!alvo) {
    throw new Error(
      'KIVO_DB_PATH não definida. Este teste APAGA o banco que usar — rode via ' +
      '`node scripts/kivo test:recuperacao-senha`, que aponta para um arquivo temporário.',
    );
  }
  const devDb = path.resolve(process.cwd(), 'database', 'kivo.db');
  if (path.resolve(alvo) === devDb) {
    throw new Error(`Recusado: KIVO_DB_PATH aponta para o banco de dev (${devDb}).`);
  }
  return alvo;
}

/**
 * Varre as views procurando aspa dupla solta dentro de `x-data="…"`.
 *
 * Regressão real: um comentário JS com aspas (`o "dispensar"`) dentro do x-data de 148
 * linhas do nav fechava o atributo no meio; o navegador seguia lendo até o próximo `>`
 * (o de uma arrow function) e despejava o resto do componente como texto na tela. Nenhum
 * teste de rota pega isso — a resposta HTTP é 200 e o servidor não reclama de nada.
 */
function checkViewsXData(): void {
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ejs') ? [p] : [];
    });
  };
  const files = [...walk(path.resolve('src/views')), ...walk(path.resolve('src/modules'))];
  const quebrados: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\sx-data="/g)) {
      const fim = src.indexOf('"', m.index! + m[0].length);
      // O caractere logo após a aspa de fechamento tem que ser espaço, `>` ou `/`. Se for
      // qualquer outra coisa, aquela aspa estava no MEIO do valor — atributo quebrado.
      if (fim === -1 || !/^[\s>/]/.test(src.slice(fim + 1, fim + 2))) {
        quebrados.push(`${path.relative(process.cwd(), file)}:${src.slice(0, fim).split('\n').length}`);
      }
    }
  }
  check(`x-data sem aspa solta em ${files.length} views`, quebrados.length === 0, quebrados.join(', '));
}

async function main(): Promise<void> {
  const TMP_DB = assertBancoDescartavel();
  fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });
  fs.rmSync(TMP_DB, { force: true });
  // O cofre vive ao lado da raiz de dados; com KIVO_DB_PATH temporário ele também é
  // temporário, mas limpar evita herdar segredo de uma execução anterior.
  fs.rmSync(secretsFilePath(), { force: true });

  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  const api = (p: string, opts: RequestInit = {}) =>
    fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
  const post = (p: string, b: unknown) => api(p, { method: 'POST', body: JSON.stringify(b) });

  /**
   * Desembrulha o envelope { success, data } da API. Diferente do `unwrap` de testUtils,
   * NÃO lança em resposta de erro — metade das checagens aqui são justamente sobre o que a
   * API responde quando recusa.
   */
  const body = async (r: Response): Promise<Record<string, unknown>> => {
    const raw = (await r.json()) as Record<string, unknown>;
    return raw && typeof raw === 'object' && 'success' in raw
      ? ((raw.data ?? raw) as Record<string, unknown>)
      : raw;
  };

  try {
    // ─── Formato dos códigos ───
    checkViewsXData();

    const desafioExemplo = 'A7K2-9QRM-3B4T-XZ01';
    // Vetor fixo, além da comparação entre os dois lados: se alguém "melhorar" o formato
    // nos DOIS arquivos ao mesmo tempo, a comparação continuaria passando enquanto toda
    // instalação já em campo deixaria de aceitar o código do suporte.
    check(
      'formato do código não mudou (vetor fixo)',
      expectedResponse(SEGREDO, desafioExemplo) === 'Y46T4-CTM60',
      expectedResponse(SEGREDO, desafioExemplo),
    );
    check(
      'desktop e cloud geram a MESMA resposta',
      expectedResponse(SEGREDO, desafioExemplo) === cloudExpectedResponse(SEGREDO, desafioExemplo),
      `${expectedResponse(SEGREDO, desafioExemplo)} vs ${cloudExpectedResponse(SEGREDO, desafioExemplo)}`,
    );
    check(
      'segredo diferente muda a resposta',
      expectedResponse(SEGREDO, desafioExemplo) !== expectedResponse('b'.repeat(64), desafioExemplo),
    );
    check(
      'resposta cabe numa ligação (10 dígitos + hífen)',
      /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(expectedResponse(SEGREDO, desafioExemplo)),
      expectedResponse(SEGREDO, desafioExemplo),
    );
    // Ler ao telefone erra: 'O' vira zero, 'I' vira um, e o hífen sai como espaço.
    check('leitura tolera O/I/L, espaço e minúscula', normalize('a7k2 9qrm') === normalize('A7K2-9QRM'));
    check('normalize troca O por 0 e I por 1', normalize('OI') === '01');

    // ─── Sem segredo, o resgate não é oferecido ───
    deleteSecret(RECOVERY_SECRET_KEY);
    const semSegredo = await api('/api/recovery/status');
    const stSem = await body(semSegredo);
    check('status responde sem autenticação', semSegredo.ok);
    check('sem segredo → resgate indisponível', stSem.disponivel === false);
    check('conta 1 administrador na instalação nova', stSem.administradores === 1, String(stSem.administradores));
    check('status não vaza segredo nenhum', !JSON.stringify(stSem).includes(SEGREDO));

    const iniciarSemSegredo = await post('/api/recovery/iniciar', { username: 'admin' });
    check('sem segredo → iniciar devolve 503', iniciarSemSegredo.status === 503);

    // ─── A partir daqui a instalação tem o segredo da licença ───
    setSecret(RECOVERY_SECRET_KEY, SEGREDO);

    const stCom = await body(await api('/api/recovery/status'));
    check('com segredo → resgate disponível', stCom.disponivel === true);
    check('status informa a instalação para o suporte conferir', typeof stCom.instalacao === 'string' && (stCom.instalacao as string).length === 8);

    const inexistente = await post('/api/recovery/iniciar', { username: 'ninguem' });
    check('usuário inexistente → 404', inexistente.status === 404);

    // ─── Fluxo completo ───
    const iniciar = await post('/api/recovery/iniciar', { username: 'admin' });
    const d1 = await body(iniciar);
    const desafio = String(d1.challenge ?? '');
    check('iniciar devolve desafio', iniciar.ok && desafio.length > 0);
    check('desafio vem agrupado de 4 em 4', /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(desafio), desafio);
    check('iniciar identifica o usuário alvo', (d1.user as { username?: string })?.username === 'admin');

    const gravado = db.prepare('SELECT challenge, user_id, used_at FROM password_recovery').all() as {
      challenge: string; user_id: number; used_at: string | null;
    }[];
    check('desafio gravado e ainda aberto', gravado.length === 1 && gravado[0].used_at === null);
    check('banco NÃO guarda o segredo', !JSON.stringify(gravado).includes(SEGREDO));

    const errado = await post('/api/recovery/concluir', {
      challenge: desafio, response: '00000-00000', newPassword: 'NovaSenha1',
    });
    const dErrado = await body(errado);
    check('código errado → 400', errado.status === 400);
    check(
      'código errado avisa quantas tentativas sobraram',
      String(dErrado.error).includes('Tentativas restantes: 4'),
      String(dErrado.error),
    );
    check(
      'senha NÃO mudou com código errado',
      verifyPassword('admin', (db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin') as { h: string }).h),
    );

    // A resposta é gerada pelo lado do CLOUD de propósito: é assim que acontece de verdade.
    const resposta = cloudExpectedResponse(SEGREDO, desafio);

    const fraca = await post('/api/recovery/concluir', {
      challenge: desafio, response: resposta, newPassword: 'fraca',
    });
    check('código certo + senha fraca → 400', fraca.status === 400);
    check('senha fraca explica o requisito', String((await body(fraca)).error).includes('8 caracteres'));

    const ok = await post('/api/recovery/concluir', {
      challenge: desafio, response: resposta, newPassword: 'NovaSenha1',
    });
    check('código certo + senha forte → troca', ok.ok, String(ok.status));

    const hash = (db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin') as { h: string }).h;
    check('senha nova vale', verifyPassword('NovaSenha1', hash));
    check('senha antiga não vale mais', !verifyPassword('admin', hash));

    const login = await post('/api/auth/login', { username: 'admin', password: 'NovaSenha1' });
    check('login com a senha nova funciona', login.ok);

    // ─── O desafio consumido morre ───
    const reuso = await post('/api/recovery/concluir', {
      challenge: desafio, response: resposta, newPassword: 'OutraSenha1',
    });
    check('desafio já usado não vale de novo', reuso.status === 400);
    check(
      'senha continua a que foi definida',
      verifyPassword('NovaSenha1', (db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin') as { h: string }).h),
    );

    // ─── Auditoria ───
    const log = db.prepare("SELECT action, entity, after_json FROM audit_logs WHERE action = 'senha_resgatada'").all() as {
      action: string; entity: string; after_json: string;
    }[];
    check('troca fica registrada na auditoria', log.length === 1);
    check('auditoria diz que foi via suporte', log.length === 1 && JSON.parse(log[0].after_json).via === 'codigo_de_suporte');

    // ─── Um resgate aberto por vez ───
    const primeiro = String((await body(await post('/api/recovery/iniciar', { username: 'admin' }))).challenge);
    const segundo = String((await body(await post('/api/recovery/iniciar', { username: 'admin' }))).challenge);
    check('desafios consecutivos são diferentes', primeiro !== segundo);
    const antigo = await post('/api/recovery/concluir', {
      challenge: primeiro, response: cloudExpectedResponse(SEGREDO, primeiro), newPassword: 'TerceiraSenha1',
    });
    check('pedir desafio novo invalida o anterior', antigo.status === 400);

    // ─── Tentativas esgotadas ───
    // Direto no serviço, e não pela rota: são DOIS freios independentes e este teste é
    // sobre o contador por desafio. Pela rota, o rate limit (10 tentativas por janela) já
    // teria recusado antes das 5 chegarem ao contador, e o teste passaria medindo o freio
    // errado — foi exatamente o que aconteceu na primeira versão deste arquivo.
    const reqFalso = { ip: '127.0.0.1', headers: {} } as unknown as Parameters<typeof completeRecovery>[0];
    for (let i = 0; i < 5; i++) {
      completeRecovery(reqFalso, { challenge: segundo, response: '00000-00000', newPassword: 'QualquerSenha1' });
    }
    const contador = db.prepare('SELECT attempts FROM password_recovery WHERE challenge = ?').get(segundo) as { attempts: number };
    check('cada palpite errado é contado', contador.attempts === 5, String(contador.attempts));

    const esgotado = completeRecovery(reqFalso, {
      challenge: segundo, response: cloudExpectedResponse(SEGREDO, segundo), newPassword: 'QualquerSenha1',
    });
    check(
      '5 erros travam o desafio mesmo com o código certo',
      !esgotado.ok && esgotado.error === 'tentativas_esgotadas',
      JSON.stringify(esgotado),
    );
    check(
      'senha segue intacta após o desafio travar',
      verifyPassword('NovaSenha1', (db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin') as { h: string }).h),
    );

    // ─── Rate limit da rota (o outro freio) ───
    // Este é o que protege quem está do lado de fora: sem ele, um atacante na rede da loja
    // pediria desafio novo a cada 5 palpites e o contador por desafio nunca o alcançaria.
    const alvo = String((await body(await post('/api/recovery/iniciar', { username: 'admin' }))).challenge);
    let bloqueou = false;
    for (let i = 0; i < 12 && !bloqueou; i++) {
      const r = await post('/api/recovery/concluir', { challenge: alvo, response: '00000-00000', newPassword: 'QualquerSenha1' });
      if (r.status === 429) bloqueou = true;
    }
    check('rota corta a repetição antes de virar força bruta', bloqueou);
  } finally {
    server.close();
    closeDb();
    fs.rmSync(secretsFilePath(), { force: true });
  }

  console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
