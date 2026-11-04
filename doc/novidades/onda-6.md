# Atualização — telas revisadas em celular, tablet e computador

> Mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-5.md`.

## Versão curta (WhatsApp / aviso rápido)

**PDV, Mesas e Cozinha testados nas três telas** 📱💻

- **Cozinha:** o painel agora cabe na tela do celular e do tablet. Cada etapa
  (Pendentes / Em preparo / Prontos) rola por dentro; os cards não são mais esmagados.
- **Celular/tablet deitado:** as etapas ficam lado a lado em vez de empilhadas em faixas
  de poucos pixels.
- **PDV:** o carrinho não deixa mais um vão gigante e o botão de suporte não cobre o
  total/pagamento no celular.
- **Mesas:** grade revisada; a última mesa fica acessível acima da barra inferior.

### Instalar como aplicativo
No endereço `http://` da rede local o Chrome **não permite** instalar como aplicativo
nem liberar notificação com a tela desligada — é regra de segurança do navegador, não do
Kivo. Nesse endereço:

1. use **Criar atalho** no menu do Chrome para abrir em tela cheia;
2. mantenha o botão **“Tela acesa”** ligado nos painéis de Cozinha e Mesas, que evita a
   tela apagar e o som parar.

Para instalar de verdade e receber notificação com a tela apagada, o Kivo precisa ser
acessado por **HTTPS** (com certificado reconhecido pelo tablet). É uma próxima etapa.

## Notas para o suporte
- Teste: `npm run kivo test:e2e:responsivo` — 77 checks em PDV, Mesas e Cozinha nos
  tamanhos 390×844, 844×390, 820×1180, 1180×820 e 1366×768.
- Prints: `.qa-screenshots/responsivo-3-telas/` (versão de página inteira e da janela).
- O KDS agora usa altura de viewport e colunas com rolagem própria; a página não rola
  mais atrás da barra inferior.
- Em `http://` o diálogo “Kivo no celular” explica “Criar atalho” em vez de prometer
  “Instalar aplicativo”.
