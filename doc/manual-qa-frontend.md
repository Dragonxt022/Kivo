# Manual — QA de Frontend (E2E com Playwright)

Este manual explica como rodar, interpretar e criar os testes de frontend do Kivo.

Os testes de integração em `src/tests/*.ts` exercitam a **lógica** (services, repositórios,
rotas). Eles não enxergam o que o lojista vê: layout, clique, modal, foco, tecla. Os QAs em
`src/tests/e2e/` preenchem essa lacuna abrindo um Chromium de verdade, logando pela tela e
interagindo com o DOM — e, no fim, conferindo o efeito pela API.

---

## 1. Pré-requisitos

```sh
npm install
npx playwright install chromium   # baixa o navegador (só na primeira vez)
node scripts/ensure-native-abi.js node
```

O último comando garante que o `better-sqlite3` foi compilado para o **Node** (e não para o
Electron). Se você acabou de rodar `npm run dev:electron` ou `dist:win`, o binário fica no
ABI do Electron e todo teste que abre banco morre com `ERR_DLOPEN_FAILED`. O CLI do Kivo já
faz essa checagem sozinho ao rodar qualquer `test:*`.

---

## 2. Comandos disponíveis

| Comando | O que testa |
|---|---|
| `node scripts/kivo test:e2e` | Fluxo completo de cadastro de produtos |
| `node scripts/kivo test:e2e:comandas` | Comandas e mesas |
| `node scripts/kivo test:e2e:login` | Primeiro acesso, login, logout, credencial inválida |
| `node scripts/kivo test:e2e:pdv` | PDV: busca, carrinho, pagamento, venda |
| `node scripts/kivo test:e2e:caixa` | Caixa: abrir, suprimento, sangria, fechamento |
| `node scripts/kivo test:e2e:compras` | Compras: lançar, receber, entrada no estoque |
| `node scripts/kivo test:e2e:mobile` | Layout mobile: 27 telas em 390px sem estourar a largura |
| `node scripts/kivo test:e2e:kivo-web-mobile` | Kivo Web no celular (exige MySQL/Docker) |

Os comandos também aparecem em `node scripts/kivo` (seção **Testes E2E**).

### Rodar tudo de uma vez

Não há um comando único — cada suíte é independente (porta e banco próprios). Para rodar a
bateria local:

```sh
node scripts/kivo test:e2e:login
node scripts/kivo test:e2e:pdv
node scripts/kivo test:e2e:caixa
node scripts/kivo test:e2e:compras
```

---

## 3. Como ler a saída

Cada verificação imprime uma linha:

```
  PASS  produto entra no carrinho
  FAIL  esperado na gaveta = fundo + venda — 10000
```

No fim:

```
✓ PDV/Vendas: TODOS OS TESTES PASSARAM (16 checks)
```

ou, com falhas:

```
✗ PDV/Vendas: 2 falha(s) em 16 checks
```

O processo sai com **código 0** quando tudo passa e **1** quando algo falha — é isso que faz
o CI ficar verde ou vermelho.

### Screenshots

Cada suíte grava PNGs em `.qa-screenshots/<suite>/` (pasta ignorada pelo Git). Quando um
teste falha, o screenshot do passo costuma mostrar exatamente o estado da tela — é o
primeiro lugar para olhar. O CI publica essa pasta como artefato a cada execução.

---

## 4. Isolamento do banco

As suítes rodam através de `scripts/test-isolated.js`, que cria um SQLite descartável em
temporário e o apaga no fim. **Nunca** tocam o `database/kivo.db` de desenvolvimento.

Cada suíte usa uma porta própria (3599–3604) e um servidor Express recém-iniciado — sem
Electron. Se você rodar o arquivo direto com `tsx`, sem o wrapper, ele apaga o banco padrão:

```sh
# ERRADO — mexe no banco de dev
npx tsx src/tests/e2e/pdv-venda.ts

# CERTO
node scripts/test-isolated.js src/tests/e2e/pdv-venda.ts
```

---

## 5. Kivo Web (mobile)

O teste do celular é o único que depende de infraestrutura externa: ele sobe a **nuvem**
(MySQL) e o **desktop** juntos, concede acesso remoto e abre o link num viewport de 390×844.

```sh
docker compose -f cloud/docker-compose.yml up -d
npm run kivo cloud:migrate
node scripts/kivo test:e2e:kivo-web-mobile
```

Se o MySQL não estiver acessível em `127.0.0.1:3307`, o teste **não falha**: ele imprime
`SKIP` e sai com código 0, para não deixar a máquina sem Docker com a suíte vermelha.

---

## 6. Criando um novo QA

Todo QA novo segue o mesmo esqueleto. Crie `src/tests/e2e/meu-fluxo.ts`:

```ts
import {
  Reporter,
  setupServer,
  openBrowser,
  newPage,
  loginUi,
  snapDir,
  snap,
  teardown,
  api,
  loginApi,
  unwrap,
  type E2EServer,
} from './harness';

const PORT = 3605;                 // porta única por suíte
const SHOTS = snapDir('e2e-meu-fluxo');

async function main() {
  const reporter = new Reporter('Meu fluxo');
  let server: E2EServer | undefined;
  let browser;

  try {
    server = await setupServer({ port: PORT });
    const admin = await loginApi(server.base);          // cookie para preparar dados

    // 1. Preparo por API (rápido e estável)
    const prod = await unwrap<{ id: number }>(
      await api(server.base, '/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({ name: 'Item de teste', priceCents: 1000 }),
      }, admin),
    );
    reporter.check('produto criado', !!prod.id);

    // 2. Ação pela UI (é isto que este teste existe para cobrir)
    browser = await openBrowser();
    const page = await newPage(browser);
    await loginUi(page, server.base);
    await page.goto(`${server.base}/app/alguma-tela`);
    // ... interações ...
    reporter.check('algo visível na tela', await page.locator('text=Item de teste').isVisible());
    await snap(page, SHOTS, 'tela-principal');

    // 3. Conferência pela API
    const depois = await unwrap<{ id: number }>(await api(server.base, '/api/...', {}, admin));
    reporter.check('efeito gravado', !!depois.id);
  } catch (e) {
    console.error('[e2e] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    if (server) await teardown(server.server, browser);
  }

  reporter.finish();   // imprime o resumo e encerra com 0/1
}

void main();
```

O que o `harness` já resolve para você:

- `setupServer` — apaga/cria o banco, roda migrations e seeds, ativa a licença, sai do
  estado de primeiro acesso, liga capabilities e sobe o Express.
- `newPage` — cria o contexto **com os overlays de primeira visita desligados** (tour do
  PDV, aviso de novidade). Sem isso, o tour cobre a tela e intercepta todo clique.
- `loginUi` / `loginApi` — login pela tela ou por cookie.
- `api` / `unwrap` — chamadas e desempacotamento do envelope `{ success, data }`.
- `snap` — screenshot padronizado.

Depois de criar o arquivo, registre o comando em `scripts/commands.json` e (se quiser que
apareça na listagem) em `scripts/kivo.js`, na seção **Testes E2E**.

### Opções do `setupServer`

| Opção | Para que serve |
|---|---|
| `port` | Porta do servidor de teste (uma por suíte) |
| `capabilities` | Liga capabilities antes do boot (ex.: `{ key: 'comandas.mesas', module: 'comandas' }`) |
| `firstRun` | Mantém o estado de primeiro acesso (usado pelo QA de login) |
| `skipOnboarding` | Marca o assistente como concluído (padrão `true`) |

---

## 7. Integração contínua (CI)

O arquivo `.github/workflows/ci.yml` tem:

- **`qualidade`** — `tsc --noEmit` e ESLint.
- **`testes`** — suíte de integração (com MySQL).
- **`e2e`** — produto, comandas e os quatro QAs locais (login, PDV, caixa, compras).
- **`e2e-mobile`** — Kivo Web no celular, com serviço MySQL.

Cada job de E2E publica os screenshots como artefato, inclusive quando falha.

---

## 8. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` | `better-sqlite3` no ABI do Electron | `node scripts/ensure-native-abi.js node` |
| Clique bloqueado por `.kivo-tour-capture` | Tour guiado do PDV | Use `newPage`/`newContext` do harness (já desliga) |
| `browserType.launch: Executable doesn't exist` | Chromium do Playwright não baixado | `npx playwright install chromium` |
| `ECONNREFUSED` / tela em branco | Porta já em uso por outra suíte | Use uma `port` diferente no `setupServer` |
| Mobile sai como `SKIP` | MySQL do Docker fora do ar | `docker compose -f cloud/docker-compose.yml up -d` |
| Banco de dev sumiu | Rodou o teste direto com `tsx` | Use `node scripts/test-isolated.js ...` |

---

## 9. Regra de ouro

Um QA de frontend deve provar o que só o navegador revela. Se a verificação puder ser feita
por uma chamada de API, ela pertence aos testes de integração — aqui, o valor está no
**clique, no layout e no fluxo**. Prepare dados por API quando for só preparo; exercite pela
UI tudo o que o usuário realmente toca.
