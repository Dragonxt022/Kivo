# Assinatura do Kivo — cobrança e pagamento online

Como o lojista paga o Kivo. A cobrança é registrada no **painel do cloud** (por empresa) e o
pagamento sai pelo **Mercado Pago** (Pix, boleto ou cartão). O app instalado só mostra e
oferece o pagamento — ele nunca fala com o Mercado Pago.

## Onde cada coisa vive

| Peça | Onde | Papel |
| --- | --- | --- |
| Cobranças | painel do cloud → empresa → **Cobranças** | criar, gerar pagamento, baixar, cancelar, estornar |
| Credenciais e tutorial | painel do cloud → **Pagamento online** | Access Token, assinatura do webhook, e-mail do pagador |
| Página pública | `<cloud>/pagar/<token>` | o cliente paga sem login (link que o lojista envia) |
| Webhook | `POST <cloud>/api/webhooks/mercadopago` | o Mercado Pago avisa que o pagamento mudou |
| Tela do cliente | app → **Cobranças** (`/admin/cobrancas`) | lista, alerta de vencimento e "Pagar com Pix" |

## Regras (o que não pode regredir)

1. **A notificação não é a fonte da verdade.** O webhook só diz "olhe o pagamento X"; o status
   é reconferido em `GET /v1/payments/{id}` com o Access Token. Notificação forjada não baixa
   cobrança. Sem o segredo configurado o Kivo aceita a notificação, mas continua reconferindo.
2. **A baixa tem um caminho só** (`cloud/src/charges.ts` → `settleCharge`): marca paga **só**
   se estava pendente, lança a comissão do afiliado e estende a validade quando a cobrança tem
   `extends_days`. Botão manual, webhook e "verificar agora" passam todos por ali.
3. **Idempotência**: repetir o webhook não paga de novo nem estica a licença duas vezes.
4. **O valor vem do banco.** A página pública nunca aceita valor do formulário — só o método.
5. **Toda cobrança nasce com link** (`public_token` na criação; migration `0041` preenche as
   antigas). Sem isso o lojista não tinha o que enviar antes de gerar o primeiro Pix.
6. **Extensão de validade conta de hoje** quando a licença já venceu (`GREATEST(valid_until,
   NOW())`) — cliente atrasado não perde os dias que pagou.
7. **Estorno não é automático**: `refunded`/`charged_back` só registram o status no gateway;
   desfazer a baixa (e a comissão) continua sendo ação do admin.

## Configuração (resumo do tutorial do painel)

1. Criar a aplicação em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app).
2. **Produção › Credenciais de produção** → ativar → copiar o **Access Token** (`APP_USR-`).
3. **Webhooks › Configurar notificações** → URL `https://<seu-cloud>/api/webhooks/mercadopago`,
   evento **Pagamentos** (`payment`) → salvar → copiar a **assinatura secreta**.
4. Colar as duas em **Pagamento online** e ligar o aceite de pagamento.
5. Teste: credenciais `TEST-` **não disparam webhook** — o teste é pelo "Simular recebimento"
   do próprio painel do Mercado Pago.

## Teste automatizado

`node scripts/test-isolated.js src/tests/billing-gateway.ts` (ou `npm run kivo test:billing-gateway`).

Ele sobe um **Mercado Pago de mentira** dentro do próprio teste e aponta o cloud para ele com
`MP_API_BASE`, então roda sem internet, sem credencial real e sem dinheiro: credenciais,
criação da cobrança com link, página pública, Pix (QR + copia e cola), boleto, cartão
(Checkout Pro), confirmação por status, webhook com assinatura válida/inválida e idempotência.
Requer o MySQL do `cloud/docker-compose.yml` no ar (`npm test` o marca como **SKIP** sem ele).

## Arquivos-chave

- `cloud/src/gateway.ts` — Mercado Pago: credenciais, criação de Pix/boleto/preferência,
  leitura de status, validação da assinatura (`MP_API_BASE` é configurável para teste).
- `cloud/src/charges.ts` — cobrança: token público, gravação do resultado e `settleCharge`.
- `cloud/src/routes/{webhooks,payments,payPublic,billing}.ts` — webhook, painel, página
  pública e as rotas que o app consome.
- `cloud/src/views/{payments,pay-public}.ejs` — tutorial/credenciais e a página de pagamento.
- `src/core/billing/*` + `src/views/billing.ejs` — o lado do app.
