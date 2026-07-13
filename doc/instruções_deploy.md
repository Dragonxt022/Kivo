# Guia de Deploy — Katsu

Passo a passo para desenvolver, testar e publicar novas versões do Katsu (app desktop) e do `cloud/` (painel + servidor na VPS).

---

## 1. Desenvolvimento do dia a dia

```bash
npm run dev
```

- Roda o app local via `tsx` (sem Electron), em `http://localhost:3123`.
- O script `predev` já corrige sozinho o ABI do `better-sqlite3` se necessário (troca automática entre Node do sistema e Node do Electron — não precisa mais rodar `npm rebuild` na mão).

Para testar a janela real do Electron:

```bash
npm run dev:electron
```

## 2. Rodar os testes antes de qualquer deploy

```bash
# Testes obrigatórios (sempre rodar antes de qualquer release)
npm run test:fase1
npm run test:fase1b
npm run test:shared
npm run test:fase3
npm run test:fase3c
npm run test:fase4
npm run test:fase5
npm run test:fase5b
npm run test:fase5c
npm run test:fase5d
npm run test:fase7a
npm run test:fase7b
npm run test:fase7c
npm run test:fase7d
npm run test:fase7e
npm run test:fase7f
npm run test:fase8
npm run test:fase8b
```

- `test:fase8` cobre o DRE (cálculo do demonstrativo de resultado + CRUD de categorias).
- `test:fase8b` cobre unitários de `computeLateCharges`, `recomputeStockForProducts` e `recomputeForCustomers` (ledger de crédito/pontos).
- Os testes `fase6a`/`fase6b`/`fase6c`/`fase6d` sobem um `cloud/` local (MySQL via Docker, porta 3307). Se ainda não tiver rodado:
  ```bash
  npm run cloud:install
  docker compose -f cloud/docker-compose.yml up -d
  CLOUD_DB_PORT=3307 npm run cloud:migrate
  ```

**Dica:** se você já tem `npm run dev` aberto num terminal, rode os testes com um banco isolado para não conflitar:
```bash
KATSU_DB_PATH="$(pwd)/database/katsu-test.db" npm run test:fase1b
rm -f database/katsu-test.db*
```

---

## 3. Publicar o `cloud/` (painel + servidor na VPS)

Sempre que mudar algo dentro de `cloud/`:

```bash
git add -A
git commit -m "mensagem do que mudou"
git push origin main
npm run cloud:deploy
npm run katsu cloud:deploy
```

O que `npm run cloud:deploy` faz sozinho (script `scripts/deploy-cloud.sh`):
1. Conecta na VPS via SSH (chave já configurada).
2. `git pull` no clone do repositório lá dentro.
3. `npm install` + `npm run build` do `cloud/`.
4. Roda migrations novas automaticamente.
5. Reinicia o serviço (`systemctl restart katsu-cloud`).
6. Confere `/api/health` no domínio público.

Não precisa fazer nada manual na VPS — é só isso.

### Se precisar rodar algo manual na VPS
```bash
ssh -i ~/.ssh/katsu_vps_deploy root@187.77.251.231
```

---

## 4. Lançar uma nova versão do app desktop (GitHub Release)

### 4.1. Subir a versão
Edite `package.json`, campo `"version"` (ex.: `0.1.3` → `0.1.4`).

### 4.2. Commitar
```bash
git add -A
git commit -m "chore: bump versão para 0.1.4"
git push origin main
```

### 4.3. Build + publicar a Release
```bash
npm run release:win
```

Esse comando sozinho:
1. Builda o TypeScript (`npm run build`).
2. Recompila o `better-sqlite3` para o ABI do Electron (`rebuild:electron`).
3. Verifica se o binário nativo está mesmo compatível antes de empacotar (`verify:native` — se não estiver, o comando para com erro em vez de gerar um instalador quebrado).
4. Gera o instalador (`electron-builder --win`).
5. Publica a Release no GitHub (instalador + `latest.yml`), já como release pública (não fica em rascunho).

**Importante:** precisa da variável `GH_TOKEN` (token do GitHub, escopo `public_repo`) disponível na sessão. Se você já rodou `setx GH_TOKEN "..."` uma vez, ela já fica salva permanentemente pro seu usuário do Windows — não precisa repetir.

**Atenção:** só dar `git push` **não** libera nada para quem já tem o Katsu instalado. É `npm run release:win` que efetivamente publica a atualização.

### 4.4. Depois de publicar
Volte o `better-sqlite3` para o ABI do sistema, para continuar desenvolvendo:
```bash
npm rebuild better-sqlite3
```
(Ou simplesmente rode `npm run dev` de novo — o `predev` já corrige sozinho.)

### 4.5. Conferir se a Release saiu certa
```bash
curl -s https://api.github.com/repos/Dragonxt022/katsu/releases/latest
```
Deve mostrar a tag nova (`v0.1.4`) com os arquivos `Katsu-Setup-*.exe`, `.blockmap` e `latest.yml`.

Quem já tem o app instalado recebe o aviso de atualização sozinho no próximo boot (o app checa a Release automaticamente).

---

## 5. Checklist rápido de uma release completa

- [ ] Rodei os testes (`npm run test:fase*`)

  | Comando | O que testa |
  |---------|-------------|
  | `test:shared` | Utilitários de dinheiro (`toCents`, `formatBRL`) + documentos |
  | `test:fase1` | Login/RBAC/soft-delete/auditoria |
  | `test:fase1b` | Settings, backup, license lifecycle |
  | `test:fase3` | CRUD clientes/fornecedores/produtos, estoque |
  | `test:fase3c` | PIN, fechamento de caixa + relatório |
  | `test:fase4` | Caixa, contas a pagar/receber, fluxo de caixa |
  | `test:fase5` | PDV completo (vendas dinheiro/PIX/prazo, estoque, cancelamento) |
  | `test:fase5b` | Quotes (orçamentos), purchases, permissões |
  | `test:fase5c` | Troca de senha, categorias, renderização de impressão |
  | `test:fase5d` | Formas de pagamento com taxa, split payment, cancelamento |
  | `test:fase7a` | Venda parcelada (recebíveis), carnê |
  | `test:fase7b` | Filtros de cliente, CEP |
  | `test:fase7c` | Crédito de loja, convergência offline |
  | `test:fase7d` | Pontos de fidelidade, convergência offline |
  | `test:fase7e` | Convênio (agreement), faturamento |
  | `test:fase7f` | Idempotência de venda (clientRequestId) |
  | **`test:fase8`** | **DRE (demonstrativo + categorias)** |
  | **`test:fase8b`** | **Unitários: lateFees, recomputeStock, recomputeLedger** |

- [ ] Mudei algo em `cloud/`? → commit + push + `npm run cloud:deploy`
- [ ] Mudei algo no app desktop? → subir versão em `package.json`
- [ ] `git add -A && git commit && git push`
- [ ] `npm run release:win`
- [ ] Conferir a Release no GitHub
- [ ] `npm rebuild better-sqlite3` (voltar pro ABI de dev)

---

## 6. Problemas conhecidos

- **Erro de `NODE_MODULE_VERSION`** ao rodar `npm run dev`/testes: normal se a última coisa que você rodou foi `npm run dist:win`/`release:win`. O `predev` já resolve sozinho na próxima vez que rodar `npm run dev`. Se quiser forçar na mão: `npm rebuild better-sqlite3`.
- **`EPERM`/arquivo travado** ao rodar `electron-rebuild`: geralmente é outro processo Node ainda rodando (um `npm run dev` esquecido aberto em outro terminal). Feche-o e tente de novo.
- **Release saiu como rascunho** (não devia mais acontecer, mas caso aconteça): entre em https://github.com/Dragonxt022/katsu/releases, edite a Release e clique em "Publish release".
