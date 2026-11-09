# Cardápio Online e Pedido pela Mesa (QR) — Regras de Negócio

Vitrine pública do catálogo e pedido feito pelo celular na mesa. São dois recursos
relacionados, mas independentes: o **cardápio online** mostra os produtos marcados e o
**pedido pela mesa (QR)** transforma essa vitrine em pedido, com confirmação do garçom.

## Visão geral

- `commercial.cardapio_online` — publica no Cloud os produtos marcados como **Visível no
  cardápio**. A página é pública (`/cardapio/:companyUuid`), sem login.
- `comandas.pedido_qr` — gera o QR de cada mesa e recebe pedidos pelo celular. Depende de
  `comandas.mesas`; no Cloud, exige plano **Diamante** ou **Trial**.
- O cardápio do QR é um **snapshot** enviado pelo app local. O Cloud nunca lê o banco do
  lojista; ele só guarda a projeção pública (nome, descrição, preço, categoria, foto e
  complementos).

## Publicação do cardápio

Ao marcar um produto como visível (`PUT /api/commercial/products/:id/cardapio-online`):

1. grava `products.visivel_cardapio = 1`;
2. agenda a publicação do menu (`scheduleMenuPublish(1200)`) e um sync best-effort;
3. envia a foto do produto para o banco de imagens do Cloud — a página pública não
   consegue ler o arquivo local;
4. o item passa a aparecer na página pública depois da publicação.

O sync geral projeta os produtos visíveis em `menu_items` (nome, descrição, preço,
categoria e `catalog_image_id`). Um produto desmarcado, excluído ou desativado sai da
projeção; um resync completo apaga e recria `menu_items` da empresa.

O publicador do QR (`src/core/menu/publisher.ts`) monta um snapshot mais rico, com
complementos e ordem de exibição, e envia para `POST /api/menu/publish`. Ele roda:

- a cada **45 segundos** (enquanto o app está aberto);
- quando uma capability muda (ex.: ligar/desligar `comandas.pedido_qr`);
- quando um produto é marcado/desmarcado do cardápio;
- antes de gerar um QR novo, para o cliente não abrir um cardápio vazio ou velho.

O snapshot só vai habilitado quando a licença está válida, o plano é Diamante/Trial e a
capability `comandas.pedido_qr` está ligada. O Cloud grava `menu_publications.enabled` e
substitui `menu_items` da empresa; ao desligar, mantém os itens para a reativação ser
instantânea, mas o QR deixa de aceitar pedidos.

A página pública (`GET /cardapio/:companyUuid`) agrupa por categoria e usa a foto vinculada
ao item. A rota de imagem (`GET /cardapio/:companyUuid/imagem/:imageId`) só serve fotos de
itens realmente publicados pela empresa — não é um mural de imagens de terceiros.

## QR da mesa

O token em claro é gerado no app local e guardado em `store_tables.qr_token`; o Cloud
guarda apenas o **SHA-256** em `menu_table_tokens`, com um token por mesa/empresa.

`generateTableQr` só funciona quando:

- a capability `comandas.pedido_qr` está ativa;
- o plano é Diamante ou Trial;
- a licença está válida;
- o Cloud está configurado (URL e credenciais);
- o cardápio foi publicado com sucesso.

A primeira chamada cria o token e o QR; abrir a janela de novo reexibe o mesmo código.
**Gerar novo** rotaciona o token e invalida o QR impresso anterior; **Desativar** marca o
token como inativo no Cloud e limpa o token local — quem tiver o link antigo não consegue
mais pedir. A URL pública é `${cloud}/pedido/${token}` e o QR é renderizado no próprio app
(`QRCode.toDataURL`).

## Fluxo do pedido

1. O cliente abre `GET /pedido/:token`. O Cloud resolve o token e devolve o cardápio
   publicado (`GET /api/pedido/:token/menu`).
2. O cliente monta o carrinho (itens, complementos, observações, "para viagem") e envia
   `POST /api/pedido/:token/orders`.
3. O Cloud valida token, plano, validade da empresa, publicação habilitada, produtos,
   complementos e preços; grava `public_orders` com status `recebido` e cria uma
   `company_commands` do tipo `comandas.qr.order` para a máquina da mesa.
4. O app local aplica o comando (`receiveQrOrder`): valida de novo produto/preço/
   complementos, cria a comanda se necessário e lança os itens com `origem = 'cliente_qr'`.
   O pedido nasce em `qr_orders` como `pendente`; **nada vai para a cozinha**.
5. A tela de Mesas mostra o banner **Pedido do cliente aguardando confirmação** e um selo
   na mesa. O garçom confirma (`POST /api/comandas/comandas/:id/qr-orders/confirm`) ou
   recusa com motivo (`.../reject`).
6. Ao confirmar, os itens são enviados à cozinha. Ao recusar, o motivo é gravado e o
   cliente vê a mensagem no celular. O cliente consulta o andamento em
   `GET /api/pedido/:token/orders/:orderUuid`.

## Mesa aberta e antiabuso

- `pedido_qr.exigir_mesa_aberta` (padrão **ligado**): o QR só aceita pedido se a mesa já
  tiver uma comanda aberta pelo atendente. Sem isso, alguém de fora com o link salvo
  conseguiria abrir uma mesa livre. A mensagem orienta o cliente a chamar o atendente.
- `pedido_qr.abrir_mesa_auto` (legado, padrão ligado): usado apenas quando a exigência
  acima está desligada; permite que o QR abra a mesa sozinho.
- O Cloud limita a **8 pedidos por 10 minutos** por token + IP e a **2 rodadas pendentes
  por mesa em 30 minutos**. A terceira rodada só entra depois de uma confirmação/recusa.
- Cada pedido aceita até 40 itens; quantidade por item é limitada a 20 e por complemento a
  10; o payload de complementos é limitado a 20 itens por linha.
- Se a mesa estiver ocupada, um link vazado ainda consegue enviar até 2 rodadas; elas
  aparecem para o garçom, que recusa. Para abuso persistente, rotacione ou desative o QR.

## Histórico e recompra no celular

O histórico fica no **navegador do cliente** (`localStorage`, chave por empresa, máximo de
8 pedidos) — não é uma conta na nuvem. Cada pedido guarda itens, complementos, total, mesa,
data e status. Os status exibidos são:

- **Enviado** — o Cloud recebeu;
- **Aguardando atendente** — o app local aplicou o comando, mas o garçom ainda não decidiu;
- **Confirmado** — o garçom confirmou e a cozinha recebeu;
- **Recusado** — o garçom recusou (com motivo);
- **Falhou** — o app local não conseguiu aplicar o pedido.

**Pedir novamente** revalida o pedido contra o cardápio atual: remove item indisponível,
adicional que saiu do menu ou excedente de limite de grupo, e usa o preço vigente. O
cliente vê um aviso do que mudou. O carrinho em andamento fica em `sessionStorage` e
sobrevive a recarregar a página; se o envio falhar ou passar de 25 segundos, o erro aparece
dentro do carrinho, com o botão **Atualizar cardápio** quando o cardápio estiver velho.

## Entidades e endpoints

Tabelas do Cloud: `menu_publications`, `menu_items`, `menu_table_tokens`, `public_orders`,
`company_commands`. No app local: `store_tables.qr_token`, `qr_orders` (`order_uuid`,
`comanda_id`, `status`, `rejection_reason`) e `comanda_items.qr_order_id`/`origem`.

Endpoints principais:

| Onde | Rota |
| --- | --- |
| Cloud | `GET /cardapio/:companyUuid` e `GET /cardapio/:companyUuid/imagem/:imageId` |
| Cloud | `POST /api/menu/publish`, `POST /api/menu/table-tokens`, `DELETE /api/menu/table-tokens/:tableUuid` |
| Cloud | `GET /pedido/:token`, `GET/POST /api/pedido/:token/...`, `POST /api/menu/orders/:orderUuid/status` |
| App | `GET/POST/DELETE /api/comandas/tables/:id/qr` |
| App | `POST /api/comandas/comandas/:id/qr-orders/confirm` e `/reject` |
| App | `PUT /api/commercial/products/:id/cardapio-online` |

## Permissões

- `commercial.products.edit` — marcar/desmarcar produtos no cardápio.
- `commercial.cardapio_online` — capability do cardápio público.
- `comandas.pedido_qr` — capability do pedido por QR.
- `comandas.view` — ver mesas e o QR existente.
- `comandas.tables.manage` — gerar/rotacionar/desativar QR.
- `comandas.manage` — confirmar ou recusar pedidos do cliente.

## Erros comuns

- **QR inválido ou mesa desativada** — token não existe, foi rotacionado ou o QR foi
  desativado. Gere um novo QR e reimprima.
- **Pedido disponível no plano Diamante ou durante o teste** — plano atual não inclui o
  recurso; o Trial libera por 15 dias.
- **Período de teste terminou** — validade da empresa expirou no Cloud.
- **Pedido pelo celular não está disponível nesta loja agora** — a publicação do cardápio
  está desligada (capability desligada, licença inválida ou app sem publicar).
- **A mesa não está aberta** — a regra `exigir_mesa_aberta` está ligada e não há comanda
  aberta; o atendente precisa abrir a mesa.
- **Item não está mais disponível** — o cardápio mudou entre a montagem e o envio; o
  cliente deve atualizar a página e remontar o pedido.
- **Já existem pedidos desta mesa aguardando o atendente** — limite de 2 rodadas pendentes;
  aguarde a confirmação/recusa.

## Arquivos-chave

- `src/core/menu/publisher.ts` — snapshot e agendamento da publicação.
- `src/modules/comandas/qr.ts` — geração, rotação e revogação do QR.
- `src/modules/comandas/qrOrder.ts` — aplicação, confirmação e recusa do pedido.
- `src/modules/commercial/productsRoutes.ts` — marcação de produto no cardápio.
- `cloud/src/routes/menu.ts` — página pública e imagens.
- `cloud/src/routes/menuPublish.ts` — publicação, tokens e status do pedido.
- `cloud/src/routes/orderPublic.ts` — página do QR, menu público e pedidos.
- `cloud/src/public/js/pedido.js` — carrinho, histórico, recompra e status no celular.
