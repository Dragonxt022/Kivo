# Atualização 2.1.16 — pedido pelo QR, cardápio, cozinha e downloads

> Mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-7.md`.

## Versão curta (WhatsApp / aviso rápido)

**Novidades desta atualização:**

- 📱 **Pedido pela mesa via QR:** o cliente aponta a câmera, monta o pedido no celular e o
  garçom confirma antes de ir para a cozinha. Cada mesa tem seu QR, com **Copiar link**,
  **Imprimir**, **Gerar novo** e **Desativar**.
- 🔒 Por padrão, o QR só aceita pedido com a **mesa aberta pelo atendente** — evita que
  alguém de fora use um link salvo. A regra fica em Configurações → Mesas e balcão.
- 🧾 **Meus pedidos** no cardápio: o cliente vê os últimos pedidos, o status e os detalhes,
  e pode **Pedir novamente** — o sistema revalida o cardápio e avisa o que mudou.
- 🛒 O carrinho **sobrevive a recarregar a página**; se o envio falhar, o erro aparece
  dentro do carrinho, com opção de atualizar o cardápio. Envio com timeout de 25 s.
- 🍳 **Cancelar pedido na Cozinha:** disponível para pedidos pendentes, em preparo ou
  prontos; se veio de comanda, os itens são anulados e não são cobrados. Pedido já entregue
  não pode ser cancelado por ali.
- ↩️ **Voltar etapa** no item e no pedido inteiro, para corrigir toque errado. A coluna
  **Entregues** fica oculta por padrão (botão **Mostrar entregues**).
- 🔔 **Alarme até visualizar:** o som de pedido novo repete até alguém clicar em
  **Visualizei** (ou começar a preparar). Um alarme só para todos os pedidos abertos.
- 🧩 **Comandas:** anular o principal leva os complementos junto; a divisão exige o grupo
  completo e os itens continuam acompanhados pela cozinha; comandas sem mesa aparecem numa
  lista própria.
- ⬇️ **Download com cadastro:** para baixar o instalador, o visitante informa nome, celular
  e e-mail; o link tem validade de 7 dias. O painel do Cloud mostra os cadastros e os testes.
- 🖥️ **Abertura por usuário:** cada usuário pode abrir direto em um módulo (e em tela
  cheia) ao iniciar, sem mudar a tela inicial dos outros.
- 💰 **Caixa e Vendas:** filtro de período em diálogo, com atalhos de 1/7/30/90 dias, e
  resumo de vendas por forma de pagamento.
- 🖼️ Fotos do cardápio online passam a ser vinculadas ao **banco de imagens do Cloud**,
  evitando item publicado sem miniatura.

## Notas para o suporte

### Pedido pela mesa (QR)

- Requer a capability `comandas.pedido_qr` (Configurações → Recursos), plano **Diamante** ou
  **Trial**, licença válida e Cloud configurado. O cardápio é publicado pelo app local —
  não depende de sync geral (o Trial não tem sync).
- O token em claro fica em `store_tables.qr_token`; o Cloud guarda só o SHA-256 em
  `menu_table_tokens`. **Gerar novo** rotaciona e invalida o QR impresso; **Desativar**
  marca o token como inativo.
- `pedido_qr.exigir_mesa_aberta` vem **ligado**. Se o cliente reclamar de "mesa não está
  aberta", o atendente precisa abrir a comanda antes; desligar a opção volta ao fluxo antigo
  em que o QR abre a mesa sozinho.
- Limites do Cloud: 8 pedidos/10 min por token+IP e 2 rodadas pendentes por mesa em 30 min.
  Se a mesa estiver ocupada, um link vazado ainda consegue enviar até 2 rodadas; o garçom
  recusa e, em abuso persistente, o QR deve ser rotacionado/desativado.
- O pedido só vai para a cozinha depois de **Confirmar e enviar p/ cozinha**. Se o garçom
  recusar, o motivo digitado aparece no celular do cliente.
- Endpoints: `POST /api/comandas/tables/:id/qr`, `GET`/`DELETE` no mesmo caminho,
  `POST /api/comandas/comandas/:id/qr-orders/confirm` e `/reject`.
- Se o QR não abre: confira capability, plano, validade da licença, Cloud configurado e se
  o cardápio foi publicado. O app mostra o motivo exato na janela do QR.

### Cardápio online e histórico

- Produto só aparece se estiver com **Visível no cardápio** e ativo. A publicação do QR roda
  a cada 45 s e também ao marcar/desmarcar produto, ligar/desligar a capability e gerar QR.
- O histórico do cliente fica no navegador dele (`localStorage`, até 8 pedidos, chave por
  empresa). Não é conta na nuvem: trocar de celular/navegador não leva o histórico.
- **Pedir novamente** revalida item, adicional, limite de grupo e preço; o que saiu do
  cardápio é removido com aviso. O rascunho do carrinho fica em `sessionStorage`.
- Falha de envio mostra o erro dentro do carrinho; se o cardápio estiver velho, aparece
  **Atualizar cardápio**. O timeout do envio é de 25 s.
- Se a loja estiver offline, o pedido é aceito e processado quando ela reconectar.

### Cozinha (KDS)

- **Cancelar pedido** usa `POST /api/foodservice/kitchen/tickets/:id/cancel` (permissão
  `foodservice.kitchen.manage`). Recusa ticket entregue ou com qualquer item entregue.
- Ticket de comanda: os itens vinculados são anulados na mesma transação e não entram na
  conta (principal leva complementos). Ticket de venda: só o KDS é cancelado; a venda
  continua.
- Voltar etapa existe por toque errado. O recalc do ticket não rebaixa `entregue` por
  acidente; uma volta explícita manda reavaliar.
- O alarme usa `kitchen_tickets.acknowledged_at`; avançar item/ticket também marca como
  visto. A migration `0090_kitchen_ticket_acknowledged` evita alarme para pedidos antigos.
- Sons ficam no aparelho (`kds-som*` e `kds-som-cancelamento*` no `localStorage`). O
  cancelamento é detectado no polling: toca o som e mostra o aviso.

### Comandas

- Anular o principal anula o grupo inteiro (`line_group_uuid`); anular um complemento remove
  só aquela linha. A migration `0095_comanda_orphan_complements` limpa complementos órfãos
  antigos e desfaz o aviso de "pronta para pagamento" de comandas cujo total mudou.
- A divisão exige o grupo completo; os tickets da cozinha seguem os itens movidos. A comanda
  nova aparece em **Comandas sem mesa** e pode ser vinculada depois pelo botão **Mesa**.
- Na transferência, mesas ocupadas aparecem em vermelho e desabilitadas; o servidor também
  recusa. Comanda sem mesa usa **Vincular mesa**.
- A mesa mostra o selo **Pedido do cliente** enquanto há rodada de QR pendente.

### Download do instalador

- O cadastro pede nome, celular com DDD e e-mail. Validações: nome 2–120, celular 10–13
  dígitos, e-mail válido; honeypot invisível e limite de 8 cadastros/hora por IP.
- O link `/baixar/arquivo?t=...` vale por **7 dias**; o primeiro download grava
  `downloaded_at` e incrementa `download_count`.
- Se o banco estiver fora, o download é liberado mesmo assim (o cadastro é perdido).
- Painel: `/admin/downloads` (admin) com cadastros, downloads, últimos 7 dias, testes em
  andamento, link de WhatsApp e lista de trials/máquinas.
- **Mudança de empacotamento:** o build portátil foi descontinuado; o download oficial é o
  instalador NSIS (`Kivo-Setup-*.exe`). A versão exibida vem de `KIVO_APP_VERSION` ou da
  release mais recente do GitHub.

### Caixa, Vendas e Usuários

- Caixa: o botão **Filtros** abre um diálogo com data inicial/final e atalhos hoje/7d/30d/90d;
  o filtro vale para os movimentos do turno e o histórico de fechamentos. **Exportar livro
  caixa** respeita o período.
- Vendas: a barra de filtros ganhou busca, status, forma de pagamento e atalhos de período;
  o resumo mostra totais do dia por forma de pagamento e o consolidado do período.
- Abertura por usuário: `user_startup` guarda módulo e tela cheia, é desligada por padrão,
  não sincroniza e é revalidada contra as permissões a cada abertura. Se o usuário perder
  acesso ao módulo, o Kivo abre na tela inicial.

### Migrations e compatibilidade

- `0051_menu_item_catalog_image` — vínculo do item do cardápio à foto do banco de imagens.
- `0052_qr_table_ordering` — tabelas do menu público, tokens de mesa, pedidos públicos e
  comandos.
- `0053_installer_leads` — cadastro obrigatório antes do download.
- `0089_kitchen_item_complements`, `0090_kitchen_ticket_acknowledged` e
  `0095_comanda_orphan_complements` — complementos na cozinha, confirmação de visualização e
  limpeza de complementos órfãos.
- As mudanças são aditivas; não há migração destrutiva. O PDV aceita o envelope ao abrir
  comanda/orçamento no caixa (correção de compatibilidade).
