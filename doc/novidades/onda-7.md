# Atualização 2.1.11 — sons, complementos, cancelamento e entrega

> Mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-5.md` e `onda-6.md`.

## Versão curta (WhatsApp / aviso rápido)

**Novidades desta atualização:**

- 🔊 **Som de novo pedido e som de cancelamento** configuráveis na Cozinha, com prévia.
- 🛎️ **Mesas também escolhem o som** de pedido pronto, com os novos sons adicionados.
- ❌ Quando um pedido é **cancelado**, a Cozinha toca o aviso e mostra o alerta na tela.
- 🧩 **Complementos agrupados:** na comanda, Granola/Leite aparecem indentados com seta
  logo abaixo do Açaí; na Cozinha, o card mostra “＋ Granola, Leite condensado” no
  item principal — mesmo que os complementos não sejam produtos roteados.
- 🎨 **Cards da Cozinha mais limpos:** complementos em uma linha compacta, nome do produto
  sem quebrar e botões de ação em uma faixa própria — o item deixa de ficar espremido.
- 🛵 A **comanda** agora tem o seletor **Consumir aqui / Entrega** — começa em “Consumir aqui”.
- 🧹 Card de **1 item** na Cozinha não mostra mais o rodapé “Iniciar preparo” duplicado;
  pedidos com 2+ itens continuam tendo a ação do pedido inteiro.
- 🔒 HTTPS opcional com **certificado próprio** (Configurações → Rede). Para instalar como
  aplicativo no tablet, o certificado precisa ser confiável para o Chrome Android.

## Notas para o suporte

- Sons 6, 7 e 8 adicionados em `public/sons`; a lista é lida da pasta, então novos arquivos
  aparecem sozinhos.
- Chaves de som no aparelho: `kds-som*` (Cozinha) e `kivo-ready-som*` (Mesas/pedido pronto).
- O cancelamento é detectado pelo polling do KDS (status `cancelado` no ticket); toca o som
  configurado e mostra “Pedido cancelado: …”.
- Complementos: migration `0089_kitchen_item_complements` adiciona
  `kitchen_ticket_items.complements`; o item principal (`lineGroupUuid`) leva os adicionais.
  A comanda agrupa pelo `line_group_uuid` mesmo quando o banco devolve grupos intercalados.
- A comanda envia `serviceType` em `POST /api/comandas/comandas/:id/enviar-cozinha`; sem
  escolha, `local`.
- HTTPS: pasta `%APPDATA%\Kivo\certificados` (ou a mostrada em Configurações), formatos
  `https.pfx` (senha em `https.pfx.senha`) ou `https.crt` + `https.key`; porta 3443.
  Ajuda: `doc/dev/https.md`. CA local (mkcert) pode ser recusada pelo Chrome Android para
  instalação de PWA; para garantia, use certificado público de um domínio.
- Construtor: `npm run dist:win` gera `dist-installer/Kivo-Setup-2.1.11.exe` e o portátil.
