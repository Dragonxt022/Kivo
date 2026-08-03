# Kivo — Plano: Notas Fiscais Eletrônicas (NFC-e)

> **Versão do plano:** 2.0 (revisado)
> **Status:** F1 implementada — módulo `fiscal` disponível como **recurso beta**, desligado por padrão.
> **Escopo v1:** NFC-e (modelo 65). NF-e (55) fica para depois.
> **Alinhado com:** `doc/KIVO_PLANO.md` (Controller → Service → Repository, módulos por manifesto).

> ⚠️ Nada aqui substitui a conferência contra o MOC/NT vigente na hora de implementar, nem a
> validação do contador do lojista antes de qualquer emissão em produção.

---

## 1. O que mudou da v1.0 para a v2.0

A v1.0 previa emissão 100% local: certificado A1 na máquina, assinatura XML própria
(C14N + RSA-SHA1), mTLS contra a SEFAZ, validação XSD e contingência — tudo nosso.
A revisão apontou que só `signer.ts` + mTLS consomem o orçamento inteiro estimado para
F1–F4, e dependem de biblioteca de terceiro ainda não validada.

**Decisão:** o Kivo monta o pedido e um **emissor (gateway)** assina e transmite. A
interface `FiscalProvider` isola essa escolha, então trocar de emissor — ou migrar para um
motor local no futuro — não toca o domínio.

### Erros da v1.0 corrigidos

| # | Era | Ficou |
|---|---|---|
| 1 | `0055` adicionava `customers.phone` | `phone` e `cep` **já existiam**; a migration adiciona só `ie` |
| 2 | `fiscal_sequences` sem `environment` | `UNIQUE (model, serie, environment)` — homologação não queima a numeração de produção |
| 3 | Índice único de numeração só prometido no texto | `UNIQUE (model, serie, number, environment)` no DDL |
| 4 | `orig` (origem da mercadoria) ausente | coluna `products.origem` + `fiscal.origem_padrao` |
| 5 | `cMun` (código IBGE) não existia | endereço fiscal estruturado + seleção de município via API do IBGE, com cache local |
| 6 | Contingência descrita como FS-DA | FS-DA é caminho de NF-e; para NFC-e é `tpEmis=9`. Fora do escopo v1 — delegado ao emissor |
| 7 | "1ª tentativa síncrona de 1–3s" dentro de `createSale` | `createSale` é **síncrona** (`sales.ts:233`); emissão será fire-and-forget + polling no PDV |
| 8 | `detPag` a partir de `sales.payment_method` | essa coluna colapsa 5 tipos em `'pix'` (`sales.ts:279-282`); usar `sale_payments.method_type` |
| 9 | `servico` entrando em NFC-e | serviço é NFS-e municipal — fica fora |
| 10 | `cancelSale` sem relação com a nota | `cancelSale` recusa enquanto houver documento fiscal de pé |

### Riscos de segurança que a v1.0 não tratava

1. `GET /api/settings` devolve **todas** as chaves a quem tem `settings.view`.
2. O backup copia o SQLite inteiro e envia à nuvem — segredo no banco sai da máquina.
3. `safeStorage` não existia no projeto, e o servidor também roda em Node puro (`dev.ts`, testes).

→ Cofre em `src/core/secrets/`, arquivo `storage/secrets.json` **fora do banco**, cifrado com
`safeStorage` sob Electron e AES-256-GCM (chave derivada do machine id) fora dele. O fallback
é ofuscação, não segurança forte — está documentado como tal no próprio arquivo.

---

## 2. O recurso beta

Usa o mecanismo de **capabilities** que já existia (o `KIVO_PLANO.md` o chama de feature flags):
nasce com `enabled = 0`, cruza com o plano contratado, sincroniza entre caixas e tem tela em
`/admin/recursos`.

Capability: **`fiscal.nfce`** — "Nota fiscal do consumidor (NFC-e)", marcada `beta: true`.

Três ajustes no Core, reaproveitáveis por qualquer beta futuro:

- `ModuleMenuItem.capability` + filtro em `filterModuleMenu` — o item de menu só aparece com o
  recurso ligado (antes, o menu aparecia e o gate só barrava no clique);
- `capabilities.beta` (migration `0053_capabilities_beta`), preenchido a partir do manifesto —
  o código decide o que ainda é beta, não o banco;
- `/admin/recursos` mostra a descrição como título (antes exibia a `key` crua), com selo BETA
  e confirmação antes de ligar.

### Trava de ambiente

`fiscal.ambiente` fica em **2 (homologação)**. `promoteToProduction()` só passa com uma emissão
de teste autorizada registrada em `fiscal.teste_ok_em`. Voltar para homologação é sempre
permitido. Defaults de partida: `emitir_auto = 0`, `pedir_cpf = 1`.

---

## 3. Modelo de dados

| Migration | Conteúdo |
|---|---|
| `0053_capabilities_beta` (core) | `capabilities.beta` |
| `0054_fiscal_base` | `fiscal_documents` (arquivo + outbox) e `fiscal_sequences` |
| `0055_fiscal_products` | `ncm`, `cest`, `csosn`, `cst`, `origem`, `unit_fiscal` + índice `idx_products_ncm` |
| `0056_fiscal_customers` | `customers.ie` |

`fiscal_documents` guarda `xml_path` + `xml_hash`, não o XML: o arquivo vai para
`storage/fiscal/<ano>/<mes>/<chave>.xml`, mantendo banco e backup enxutos. Não entra em
`syncTables` — documento fiscal é arquivo do contribuinte naquela máquina, e a numeração por
série/ambiente não sobrevive a um last-write-wins.

### Settings vs. segredos

| `settings` (`fiscal.*`) | Cofre (`storage/secrets.json`) |
|---|---|
| `ambiente`, `serie`, `crt`, `cfop`, `cst_padrao`, `csosn_padrao`, `origem_padrao`, `emitir_auto`, `pedir_cpf`, `provider`, `id_csc`, `cert_titular`, `cert_validade`, `cert_arquivo`, `teste_ok_em` | `fiscal.csc`, `fiscal.cert_senha`, `fiscal.provider_token` |

O `.pfx` fica em `storage/fiscal/certs/`, fora do backup.

### Regra de herança fiscal

Valor do próprio produto → valor do produto pai (variantes) → padrão da configuração.
Variantes filhas herdam do pai (mesma classificação); **complementos não herdam** — viram
linha própria em `sale_items`, com `product_id` próprio, e precisam de NCM próprio.

---

## 4. Interface de configuração

`/app/fiscal/configuracao` — assistente inline de 6 passos (reusa as classes `.wizard-*` de
`app.css`, mas fora de `<dialog>`, porque o lojista volta para ajustar). Depois de configurado
abre no painel, com cada passo reeditável.

| Passo | Conteúdo |
|---|---|
| 0 | Boas-vindas + aviso de beta e do que vai precisar |
| 1 | Razão social, CNPJ (validado), IE, CRT em `choice-card`, endereço estruturado, município via IBGE |
| 2 | Upload do `.pfx` (base64 no JSON, como as fotos de produto) → devolve **titular, CNPJ e validade** |
| 3 | CSC + ID do CSC + emissor e token, com "como consigo o CSC?" expansível |
| 4 | Série, CFOP, CSOSN/CST e origem padrão, emissão automática, CPF na nota |
| 5 | Conferência (painel de prontidão) + emissão de teste |

**Painel de prontidão** (`services/readiness.ts`): cada pendência vira uma linha com o que
falta, por que importa e onde resolver — inclusive "N de M produtos sem NCM" com atalho para a
tela de edição em lote. Alerta de certificado a 30 dias do vencimento.

**Dados fiscais dos produtos** (`/app/fiscal/produtos`): tabela com gravação ao sair do campo,
aplicação em lote na seleção, e filtro "mostrar só os que faltam". Para catálogos grandes, o
caminho é o CSV: `GET /api/commercial/products/export.csv` agora traz `ncm`, `cest`, `csosn`,
`cst` e `origem`, e o import valida e regrava (coluna em branco **preserva** o cadastro).

---

## 5. Estado da implementação

### Pronto (F1)

- Módulo `fiscal` com capability beta desligada, gating de menu, API e páginas;
- cofre de segredos no Core;
- migrations 0053–0056;
- assistente de configuração + painel de prontidão;
- leitura do certificado A1 (`node-forge`) com titular/CNPJ/validade;
- municípios do IBGE com cache em disco e fallback para digitação manual;
- dados fiscais em produtos: API, edição em lote e CSV;
- guarda de `cancelSale` contra venda com nota de pé;
- `src/tests/fase_fiscal.ts` (42 verificações) + cobertura fiscal em `products-import.ts`.

### A fazer

| Fase | Entregável |
|---|---|
| **F2 — Emissor** | `FiscalProvider` + adapter do gateway; emissão de teste em homologação; tradução de rejeições; destrave de produção |
| **F3 — Emissão real** | Hook pós-venda, outbox + worker com backoff, CPF na nota no PDV, status na venda |
| **F4 — DANFE + gestão** | DANFE 80mm com QR (padrão de `store-receipt.ejs`), tela de notas completa, cancelamento |
| **Depois** | Exportação de XMLs para o contador, contingência `tpEmis=9`, NF-e 55, motor local |

### Decisões pendentes

1. **Qual emissor.** Critérios eliminatórios: já emitir campos **IBS/CBS** (a transição está
   valendo — rejeições desde 01/08/2026); devolver o XML autorizado, não só PDF; expor
   cancelamento e consulta; aceitar o certificado A1; preço por nota compatível com o ticket.
2. **Deploy da nuvem.** `KNOWN_MODULES` em `cloud/src/views/partials/module-toggles.ejs` já
   inclui `fiscal`, mas o cloud é deploy separado — sem publicar, empresas com restrição de
   módulos recebem 403.
3. **Plano de licença.** Definir se `fiscal` entra em Ouro/Diamante.

---

## 6. Como verificar

```sh
npm run kivo test:fase_fiscal   # gating do beta, numeração por ambiente, cofre, trava de produção
npm run dev                     # /admin/recursos → ligar "Nota fiscal do consumidor (NFC-e)"
node scripts/qa-browser.js /app/fiscal/configuracao --dark
```

Com o beta desligado: o item não aparece no menu, `/api/fiscal/*` responde
`403 Recurso desativado: fiscal.nfce` e as páginas redirecionam para a home.
