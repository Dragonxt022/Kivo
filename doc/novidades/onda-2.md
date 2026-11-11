# Atualização do Kuruk — interface mais rápida e PDV com periféricos

> Rascunho de mensagem de atualização para o usuário final. Pode ser enviado por
> WhatsApp, e-mail, aviso no app ou publicado na wiki. A versão curta é a primeira;
> a completa serve de base para o modal de novidades.

## Versão curta (WhatsApp / aviso rápido)

**Chegou uma atualização do Kuruk! 🎉**

Agora ficou mais rápido trabalhar no dia a dia:

- 📅 **Calendário nos filtros de data** — escolha o período no calendário, sem digitar.
- 🔎 **Busca digitável nas listas grandes** — cliente, fornecedor, município e usuário: digite e ache na hora.
- 📊 **Gráfico do início interativo** — passe o dedo ou o mouse para ver o valor de cada dia.
- 📱 **Arraste para organizar no celular** — a ordem das notificações agora funciona no toque.
- ⚖️ **Balança e impressora térmica no PDV** — leia o peso direto da balança e imprima o cupom sem o diálogo do Windows (aplicativo desktop).

Nada muda no seu login ou nos seus dados. A atualização é só de melhoria.

---

## Versão completa (modal “Novidades” / e-mail)

### Uma interface que acompanha o ritmo da loja

**Filtros de data com calendário.** Os filtros de período do DRE, financeiro, fiscal,
auditoria, painel e dos relatórios de Odonto agora abrem um calendário em português. No
celular continua o seletor nativo do aparelho, que é mais rápido no toque.

**Busca digitável nos campos grandes.** Onde antes era preciso rolar uma lista enorme
(cliente na venda a prazo, fornecedor na compra, município do emissor, usuário na
auditoria), agora dá para digitar e filtrar. A seta e o teclado continuam funcionando.

**Gráfico de evolução com detalhe.** O card “Evolução do negócio” virou um gráfico
interativo: ao passar o mouse — ou tocar no celular — aparece o valor daquele dia. Os
botões Semana / Mês / Ano continuam no mesmo lugar.

**Notificações arrastáveis no celular.** A reordenação das mensagens, que só funcionava
com mouse, agora funciona com o dedo. Segure pela alça à esquerda e arraste.

**Balança de checkout.** No PDV, ao informar a quantidade de um item vendido por peso,
aparece o botão **Ler balança** (somente no aplicativo desktop). O peso vai direto para
a quantidade, na unidade do produto (kg, g, L ou ml).

**Impressão térmica sem diálogo.** Com uma impressora ESC/POS configurada, o cupom sai
direto na térmica ao finalizar a venda. Sem impressora configurada, o Kuruk continua
abrindo a impressão normal do Windows, como antes.

### Como configurar (só no aplicativo desktop)

1. Abra **Configurações → Interface → Periféricos do PDV**.
2. **Balança:** marque “Tenho balança”, escolha a porta (ex.: `COM3`), a velocidade
   (normalmente 9600) e o protocolo (Genérico ou Toledo/Filizola). Use **Testar leitura**
   com um produto sobre o prato.
3. **Impressora:** marque “Imprimir cupom direto na térmica”, escolha o modelo, informe a
   conexão (`printer:Nome da impressora` no Windows ou `tcp://IP:9100` na rede) e a
   largura do papel (58 ou 80 mm). Use **Imprimir teste** antes de confiar no dia a dia.

A configuração vale **só para aquele computador** — o PDV do balcão pode ter os
equipamentos e o notebook do escritório não.

### O que continua igual

- Login, permissões, sincronização e dados da loja: sem mudança.
- Quem usa o Kuruk pelo navegador ou pelo celular continua com a impressão normal e o
  peso digitado à mão; a balança e a térmica são recursos do aplicativo desktop.
- O “Modo leve” continua disponível para computadores mais fracos.

---

## Notas para o suporte

- **Versão de destino:** 2.2.0 (sugestão; ajustar antes do release).
- **Arquivos de interface:** `src/public/js/kuruk-ui.js` e `src/public/css/kuruk-ui.css`
  carregam as bibliotecas sob demanda; não há bundler novo.
- **Balança:** protocolo genérico espera linha de texto com peso em kg (ex.: `1,235 kg`);
  sem separador decimal, o Kuruk interpreta como gramas. Toledo lê o frame de 6 dígitos.
- **Impressora:** o texto do cupom é montado no próprio EJS (`store-receipt.ejs`) e
  enviado em ESC/POS; se a impressora não responder em 8 s, o Kuruk cai no diálogo normal.
- **Diagnóstico:** erros de balança/impressora aparecem na própria tela de configuração
  (Testar leitura / Imprimir teste) e em `storage/logs/kuruk-AAAA-MM-DD.log`.
- **Publicação do aviso no app:** para exibir a versão completa no modal de novidades,
  atualize o conteúdo e o `KURUK_NOVIDADE_ID` em `src/views/partials/novidade.ejs` — trocar
  o id reabre o aviso para todos, sem migration.
