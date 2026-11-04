# Atualização — tela acesa nos painéis (Cozinha e Mesas)

> Mensagem para o usuário final + notas de suporte. Complementa
> `doc/novidades/onda-2.md` e `doc/novidades/onda-3.md`.

## Versão curta (WhatsApp / aviso rápido)

**Avisos com a tela sempre acesa** 🔆

- O painel da **Cozinha** e a tela de **Mesas** agora mantêm a tela do tablet/celular
  **acesa** enquanto estão abertos.
- Isso resolve o caso em que o aparelho apagava sozinho (limite de 30 minutos do Android)
  e o **som do pedido novo parava de tocar**.
- O botão **“Tela acesa”** fica no topo dos dois painéis. Ele já vem ligado; toque nele
  apenas se quiser permitir que a tela apague (economizar bateria).
- Se a tela for desligada **no botão do aparelho**, o aviso sonoro só volta ao reabrir o
  Kivo — nenhum navegador consegue tocar som com o aparelho bloqueado.

---

## Versão completa

### Por que acontecia
No acesso pela rede local o Kivo abre por `http://192.168...`. esse endereço **não é um
contexto seguro** para o navegador, então a API que mantém a tela acesa (`Screen Wake
Lock`) não existe ali. O Android apagava a tela no tempo máximo configurado (até 30 min)
e, com a tela apagada, o navegador suspende a página: o ciclo que toca o som e mostra o
toast do pedido novo para.

### O que mudou
- **Cozinha:** o painel pede `navigator.wakeLock.request('screen')` quando o navegador
  permite. No `http://` da rede local ele cai automaticamente para um **vídeo mudo de
  2×2 px em loop** (a mesma técnica do NoSleep.js), que mantém a tela ligada no
  Android/Chrome. Esse caminho não depende de HTTPS.
- **Mesas:** a mesma proteção, porque é a tela em que o garçom espera o aviso de
  “pedido pronto”.
- **Botão “Tela acesa” / ícone de sol** nos dois painéis:
  - **Ligado (padrão):** a tela não apaga enquanto o painel estiver aberto.
  - **Desligado:** o Kivo deixa o aparelho apagar normalmente (útil fora do horário).
  - A escolha fica **no aparelho** (`localStorage`), não na empresa.
- Ao voltar de uma aba em segundo plano, o Kivo **repõe** a proteção sozinho.
- O acesso por `https://`/localhost continua usando o Wake Lock nativo, sem vídeo.

### Limite que continua existindo
Se alguém **desligar a tela no botão do aparelho** (ou bloquear o tablet), o navegador
suspende a página e nenhum site consegue tocar áudio. O Kivo volta a avisar assim que a
tela for reaberta. Aviso do sistema com o aparelho bloqueado continua exigindo HTTPS e
permissão de notificação.

## Notas para o suporte
- Arquivo do recurso: `src/public/js/keep-awake.js` (carregado só em
  `/app/foodservice/cozinha` e `/app/comandas/mesas`, via `partials/nav.ejs`).
- Chave do aparelho: `localStorage: kivo:keep-awake` (`1` ligado, `0` desligado).
- O CSP ganhou `media-src 'self' data: blob:` para liberar o vídeo embutido
  (`src/core/server.ts`).
- Teste de regressão: `npm run kivo test:e2e:tela` ou
  `node scripts/test-isolated.js src/tests/e2e/tela-sempre-acesa.ts`.
- Se um Android muito antigo não aceitar o vídeo, o botão continua funcionando e a tela
  pode apagar; nesse caso, ajuste o tempo de tela do aparelho para o máximo e desative a
  otimização de bateria para o Chrome/Kivo (Configurações → Apps → Bateria → Sem
  restrições). Em aparelho muito apertado de memória, feche outros apps.
