# PDV e Mercado Pago — maquininha (Point) e pagamentos no ponto de venda

Plano de integração para receber pagamentos com cartão (via **maquininha Mercado Pago Point**) nos
fluxos de venda do Kuruk (PDV, comanda, balcão e orçamento convertido em venda).

Complementa:

- `assinatura.md` — cobrança/pagamento online (licenças) via Mercado Pago;
- `vendas.md` — criação, cancelamento e devolução de vendas;
- `financeiro.md` — caixa e formas de pagamento/taxas.

## 1. Estado atual (o que já existe)

### 1.1 Integração Mercado Pago — lado cloud

| Peça | Onde | Papel |
| --- | --- | --- |
| Gateway único | `cloud/src/gateway.ts` | `MP_API_BASE`, settings (`mp_enabled`, `mp_access_token`, `mp_webhook_secret`, `mp_payer_email`), `mpRequest` (com `X-Idempotency-Key`), `createPixPayment` (`POST /v1/payments`), `createBoletoPayment`, `createCardPreference` (Checkout Pro `POST /checkout/preferences`), `getPayment`, `mapPaymentStatus`, `verifyWebhookSignature`, `friendlyGatewayMessage`. |
| Cobranças (licenças) | `cloud/src/charges.ts` | `ChargeRow`, `settleCharge` (único ponto de baixa idempotente), `extendLicense`. Cobrança = fatura de licença/assinatura. |
| Webhook | `cloud/src/routes/webhooks.ts` | `POST /api/webhooks/mercadopago`; tipos aceitos: `payment`, `subscription_preapproval`, `subscription_authorized_payment`. Notificação não é fonte da verdade (status é reconferido na API). |
| Rotas | `cloud/src/routes/{payments,billing,payPublic}.ts` | Admin (`/admin/payments`, `/admin/companies/:uuid/charges/:id/gateway|sync`), app (`/api/billing/charges`, `/api/billing/charges/:id/gateway|status`), pública (`/pagar/:token`). |

### 1.2 Lado do PDV (app local)

| Peça | Onde | Papel |
| --- | --- | --- |
| Venda | `src/modules/store/sales.ts` | `createSale`, `resolveSalePayments`, idempotência por `clientRequestId`, caixa, estoque, receivables. |
| Pagamentos | `sale_payments` (SQLite) + `payment_methods` (`fee_bps`) | Tipos: `dinheiro`, `debito`, `credito`, `pix`, `prazo`, `credito_loja`, `fidelidade`, `convenio`… |
| Caixa | `src/modules/finance/cash.ts` | Abertura/sangria/entrada; movimento de venda em dinheiro. |
| Frontend | `src/modules/store/views/store-pdv.ejs` + `src/public/js/payment-methods.js` | Grade de meios, `settleMethods`, `pay-quick-methods`. |

### 1.3 O que NÃO existe hoje

- **Nenhum ponto de chamada ao Mercado Pago no fechamento de venda** — pagamento presencial (cartão
  na maquininha) não gera cobrança/intenção no MP nem recebe status.
- O fechamento grava pagamento localmente; cartão hoje é apenas forma local com `fee_bps`.
- O app **nunca fala com o Mercado Pago** — só com o cloud (`src/core/billing/service.ts` via `/api/billing`).

## 2. Objetivo do plano

Permitir que o operador feche vendas no PDV com cartão via maquininha Mercado Pago Point, de modo que:

1. Ao finalizar a venda com cartão, o Kuruk **crie uma ordem/intenção de pagamento no Mercado Pago** e a
   **carregue no terminal**;
2. O comprador paga no terminal (débito/crédito/pré-pago, chip/NFC) ;
3. O Mercado Pago **notifica o Kuruk** do status ;
4. O Kuruk **baixa a venda** (marca paga, registra comissão, estende o que for devido) de forma
   idempotente;
5. Estornos/reembolsos e cancelamentos voltem para o fluxo de devoluções/cancelamento.

## 3. Decisão: qual API do Mercado Pago para a maquininha

**Recomendação: API de Integrações Point via Orders API (`POST /v1/orders`)** — para integrações novas.

Do conteúdo retornado pelo MCP do Mercado Pago (`search_documentation`):

> RED_MESSAGE — *Mercado Pago está evoluindo a maneira de integrar e agora oferecemos uma nova API para
> realizar integrações com Mercado Pago Point, que descontinuará a API atual. Caso você esteja
> integrando esta solução de pagamento pela primeira vez, acesse a nova documentação de
> [integração a partir da API de Orders](/developers/pt/docs/mp-point/create-application).*

Consequências para o plano:

- **Orders API** (`/developers/pt/docs/mp-point/create-application`) substitui a Payment Intents
  (`/point/integration-api/...`) como caminho recomendado.
- **Migração** Payment Intents → Orders: criar intenção vs. order, obter, cancelar, reembolsar, listar
  terminais e alterar modo de operação mudam de endpoint (tabela resumida em anexo do plano).
- **Headers**: Orders exige `X-Idempotency-Key` (UUID v4) nas operações de create/cancel/refund; o header
  `x-test-scope` foi **removido** (agora usa usuários de teste).
- **Status**: `created → at_terminal → processed | failed | canceled | expired`; `action_required`
  (PDV, ~40s, confirmação no terminal); `waiting_capture` (reserva); `processed → refunded`.
- **Expiration**: `expiration_time` configurável; sem ela, 15 min (PDV) ou 15 s (SELF_SERVICE).
- **Fluxo**: criar order → carregar no terminal (botão *cobrar*/*ver*) → comprador paga → notificação
  de status → backend atualiza.

Dispositivos compatíveis: Point Smart, Point Pro 2 e Point Plus/POS; processa cartões, pagamentos sem
contato e SWIFT; operação no modo **PDV**.

Pré-requisitos de negócio (fora do código): terminal Point adquirido, app Mercado Pago no celular do
operador, conta de vendedor, conta MP da empresa (app `App-Assinaturas-20261030-c1a6c75cc8` já criado).

## 4. Arquitetura proposta dentro do Kuruk

1. **Fronteira app ↔ cloud mantida**: o app não fala com o Mercado Pago; o cloud é o único ponto
   (`MP_API_BASE`, Access Token) — mesmo critério de `assinatura.md`.
2. **No fechamento de venda com cartão**: o app dispara (ou o cloud, via endpoint novo) a criação da
   order vinculada à venda.
3. **Cloud**: novas funções de gateway no `gateway.ts` —
   - `createPointOrder(input, settings)` → `POST /v1/orders`;
   - `getPointOrder(orderId, settings)` → `GET /v1/orders/{orderId}`;
   - `cancelPointOrder(orderId, settings)` → `POST /v1/orders/{orderId}/cancel`;
   - `refundPointOrder(orderId, settings)` → `POST /v1/orders/{orderId}/refund`;
   - listagem/alteração de terminal: `GET /terminals/v1/list`, `PATCH /terminals/v1/setup`.
4. **Webhook**: reutilizar `POST /api/webhooks/mercadopago`; vínculo venda↔order via
   `external_reference` (proposta: `sale:<saleId>`).
5. **Baixa/estorno**: novo caminho de reconciliação na cloud que converte status da order em ação sobre a
   venda (sem reusar `settleCharge`, que é de cobrança/licença).

## 5. Endpoints que o plano prevê criar

No cloud (seguindo o padrão de `billing.ts`/`payments.ts`):

| Método e rota | Função |
| --- | --- |
| `POST /api/billing/orders` | Criar order no MP a partir de venda (body: `saleId`). |
| `GET /api/billing/orders/:id` | Consultar status da order. |
| `POST /api/billing/orders/:id/cancel` | Cancelar order (pós-envio ao terminal). |
| `POST /api/billing/orders/:id/refund` | Reembolsar order. |

No app (reaproveitando `src/core/billing/service.ts` → `cloudFetch`): espelhar os mesmos caminhos para o
fluxo PDV.

## 6. Webhook, idempotência e conciliação

- URL: `https://<cloud-public>/api/webhooks/mercadopago` (já existe; secret + HMAC já validados).
- Topics relevantes: `payment`, `order`, `point_integration_wh` (validar no MCP/painel antes do go-live).
- Sempre reconciliar via API (`getPayment`/`getOrder`) e manter idempotência (responder 200/201 nos
  estados não-actionable, 500 quando a falha é nossa; baixa idempotente).
- Evento `action_required` (PDV): confirmar no terminal e re-consultar — não baixar automaticamente.

## 7. Modelo de dados (migrations a propor)

- **App (SQLite)**: colunas em `sale_payments` (ou cabeçalho `sales` quando a venda teve um único
  pagamento de cartão): `mp_order_id`, `mp_payment_id`, `mp_status`, `mp_status_detail`, `mp_external_reference`.
- **Cloud (MySQL)**: persistir order/payment do MP por empresa/cobrança de venda ou tabela dedicada
  (`point_orders`), com índice por `external_reference`.

## 8. Taxas e caixa

- Taxa da maquininha: hoje `fee_bps` em `payment_methods` (config por máquina/terminal — não sincroniza).
- Registrar `fee_cents` no pagamento/venda (DRE) e manter comissão no fluxo de baixa.

## 9. Testes

- Estender os stubs existentes de Mercado Pago: `src/tests/billing-gateway.ts` (FakeMp do cloud) e
  `src/tests/billing-app-pix.ts` (FakeMp do app) com:
  - `POST /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/refund`;
  - simular aprovação (`processed`) e falha (`failed`).
- Cobrir: venda → criação order → aprovação → baixa idempotente → estorno; webhook HMAC válido/inválido.

## 10. Roadmap sugerido

1. **Fase 0 — Preparação Mercado Pago**: confirmar app de in-person (`payment_solution:
   in_person_payments`, product `point`), terminal, homologação via MCP (`create_application`,
   `form_homologation`, `save_webhook`, `quality_checklist`, `quality_evaluation`).
2. **Fase 1 — Cloud**: gateway de orders + endpoints + webhook (reutilizando `mpRequest`/`X-Idempotency-Key`).
3. **Fase 2 — Fluxo venda → order**: criar order vinculada à venda; persistir IDs no Kuruk.
4. **Fase 3 — Fluxo PDV**: no final da venda com cartão, disparar criação da order; aguardar status
   (webhook/polling) e baixar a venda.
5. **Fase 4 — Estorno/cancelamento**: reembolso → devolução/cancelamento conforme regras existentes.
6. **Fase 5 — Homologação e produção**: credenciais, webhook no painel MP, teste com cartão de teste.

## 11. Checklist de qualidade (Mercado Pago — via MCP)

- `create_application` (in-person: product `point`; disponível nos países MLA/MLB/MLC/MLM);
- `form_homologation` (product_id 36 = Point, conforme MCP);
- `save_webhook` (topics: `payment`, `order`, `point_integration_wh`);
- `quality_checklist` (hoje retornou erro — aplicação ainda não homologável; reavaliar pós-homologação);
- `quality_evaluation` (order_id para integração Orders);
- `notifications_history` (diagnóstico de delivery).

## 12. Decisões em aberto

- API definitiva: **Orders** (recomendado) ou Payment Intents (legado);
- Onde persistir o vínculo order↔venda (coluna em `sale_payments` vs tabela dedicada);
- Estorno deve reverter venda (estoque/devolução) ou apenas registrar;
- Estratégia de conciliação quando a venda já foi gravada localmente (ex.: operação offline/correção).
