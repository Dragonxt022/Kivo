# Atualização — padrões da loja e chave geral de estoque

> Rascunho de mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-2.md`.

## Versão curta (WhatsApp / aviso rápido)

**Ajustes desta atualização:**

- 🔊 **Som ligado por padrão** no painel da Cozinha e no aviso de pedido pronto do Garçom.
- ☁️ **Sincronização com a nuvem já ligada**, a cada 3 minutos.
- 📶 **Acesso pela rede local já ligado** — o celular/tablet da loja abre o Kivo sem configurar.
- 🧭 **Atalhos de páginas recentes desligados por padrão** (ativáveis em Configurações → Interface).
- 📦 **Controle de estoque ligado por padrão**, com uma **chave geral** para desligar a quantidade de todos os produtos de uma vez, sem mexer no cadastro item por item.

Nada muda no login, nas permissões ou nos dados já cadastrados.

---

## Versão completa

### Áudio e notificações
- **Cozinha (KDS):** o som de novo pedido nasce **ligado**, usando o som padrão do sistema
  (`pedido.mp3`). A cozinha só fica silenciosa se alguém escolher “Silencioso” no diálogo.
- **Garçom (mesas):** o aviso de **pedido pronto** também nasce ligado.
- O primeiro toque na tela libera o áudio do navegador; os próximos pedidos tocam sem
  precisar de nova interação.

### Sincronização e conectividade
- **Sincronização em nuvem:** intervalo padrão de **3 minutos**, já ativo. Fechar uma venda
  continua disparando um envio imediato, sem esperar o ciclo.
- **Acesso pela rede local:** já vem **ligado**. Se o Windows/firewall recusar a porta, o Kivo
  volta sozinho para “somente este computador” e avisa na tela de Configurações → Rede.

### Interface
- **Atalhos de páginas recentes:** agora **desligados por padrão**. Quem gostava dos balões
  pode religar em **Configurações → Interface**.

### Estoque
- **Controle de quantidade ligado por padrão** no cadastro de produtos.
- **Nova chave geral em Configurações → Estoque:** “Controlar a quantidade de estoque dos
  produtos”.
  - **Ligada (padrão):** cada produto segue o próprio cadastro (`controla estoque` ou não).
  - **Desligada:** o Kivo para de baixar/entrar saldo e de mostrar alertas de estoque
    mínimo/validade para **todos** os produtos — sem precisar desmarcar um por um.
  - O cadastro individual de cada produto é **preservado**; ao religar a chave, o
    comportamento anterior volta.

## Notas para o suporte
- Chave em `settings`: `estoque.controlar_quantidade` (`1` ligado / `0` desligado).
- A chave não altera `products.track_stock`; é um override aplicado na baixa/entrada,
  nos alertas do Painel, no relatório de estoque e na exibição de saldo no PDV/Comandas.
- Com a chave desligada, ajuste manual de estoque e baixa de lote são recusados com uma
  mensagem explicando onde religar. Venda, compra e estorno continuam funcionando, só não
  movimentam quantidade.
- Teste de regressão: `node scripts/test-isolated.js src/tests/stock-control.ts`.
