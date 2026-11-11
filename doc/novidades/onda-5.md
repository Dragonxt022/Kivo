# Atualização — local x entrega no painel da cozinha

> Mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-4.md`.

## Versão curta (WhatsApp / aviso rápido)

**A cozinha agora sabe para onde vai cada pedido** 🍽️🛵

- **Consumir no local:** o card da cozinha mostra o ícone de **prato e garfo** com o selo
  **“Local”**.
- **Entrega:** mostra o ícone de **motinha** com o selo **“Entrega”**.
- No **PDV**, ao lado do carrinho, há dois botões grandes: **“Consumir aqui”** e
  **“Entrega”**. Escolha antes de tocar em **“Enviar para cozinha”**.
- A comanda de mesa continua automaticamente como **Local**.

---

## Versão completa

### Como usar no dia a dia
1. No PDV, adicione os itens normalmente.
2. Quando aparecer o bloco **Tipo do pedido**, escolha:
   - **Consumir aqui** (prato/garfo) — cliente vai comer no balcão/mesa.
   - **Entrega** (motinha) — pedido vai sair para delivery.
3. Toque em **Enviar para cozinha**.
4. No painel da cozinha, o card chega com o ícone e o selo do tipo escolhido.

A escolha fica guardada por venda/aba do PDV: trocar de aba ou recarregar a página não perde
o tipo. Ao limpar o carrinho ou concluir a venda, volta para **Consumir aqui**. Se trocar o
tipo **depois** de já ter enviado itens, o que está na cozinha mantém o tipo anterior — o
Kuruk avisa, e só os próximos itens vão com a nova escolha.

### Comandas de mesa
Toda comanda enviada pelo garçom entra como **Local**. Pedidos de entrega devem ser lançados
pelo PDV, onde o operador escolhe o tipo.

### Aviso de pedido pronto
O aviso também passou a dizer **“Entrega — Pedido #…”** quando for delivery, para o garçom
não procurar uma mesa que não existe.

## Notas para o suporte
- Coluna nova: `kitchen_tickets.service_type` (`local` | `entrega`), migration
  `0088_kitchen_ticket_service_type`.
- O tipo viaja em `POST /api/store/kitchen/send` (`serviceType`) e no corpo da venda
  (`createSale`). A comanda envia `local` fixo.
- O KDS usa `service_type` no selo/ícone; tickets antigos (sem a coluna) são tratados como
  `local`.
- Teste de regressão: `npm run kuruk test:e2e:tipo-pedido`.
- Limitação atual: o módulo **Mais Delivery** é somente leitura e não gera ticket de cozinha;
  os pedidos de entrega precisam ser lançados pelo PDV para aparecerem no KDS com a motinha.
  Se quiser a integração direta do marketplace com a cozinha, é uma próxima etapa.
