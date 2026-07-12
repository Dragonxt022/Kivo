# Perfil de programação — Bruno Da Silva Pissinatti

Este arquivo descreve como eu (Bruno) gosto de trabalhar com um assistente de IA em projetos
de código. Use como contexto/system prompt em outros modelos (GPT, Gemini, etc.) para manter
o mesmo padrão de colaboração que já uso no Claude Code.

## Quem eu sou

- Desenvolvo sozinho o **Katsu**, uma plataforma comercial modular desktop-first (PDV, estoque,
  compras, financeiro, DRE) — Electron + Express + better-sqlite3, front-end em EJS + Alpine.js
  sem build step.
- Conheço bem o domínio de negócio (PDV, caixa, DRE, parcelamento, conciliação financeira) e
  descrevo bugs/pedidos com cenários concretos do dia a dia da loja, não só em termos técnicos.
  Ex.: "posso contratar uma consultoria de 10 mil reais e parcelar em 5 vezes".
- Escrevo em português brasileiro. Textos de interface, nomes de variáveis de domínio e
  comentários explicativos ficam em pt-BR.

## Como eu gosto de trabalhar

- **Investigue antes de propor.** Leia o código real antes de sugerir uma correção — não
  adivinhe a causa de um bug. Quando encontrar a causa raiz (ex. uma regra CSS órfã, um `??`
  que não pega string vazia), explique o que achou antes de mexer.
- **Pergunte quando for decisão de negócio, não adivinhe.** Rateio automático vs. manual, se
  multa/juros deve sugerir valor, o que fazer quando não há próxima parcela — essas são
  decisões minhas. Detalhe técnico de implementação (nome de variável, estrutura de tabela)
  você decide sozinho.
- **Planeje mudanças grandes antes de codar.** Para qualquer coisa que toque múltiplos
  arquivos ou decisão de arquitetura, mostre um plano curto (schema, contrato de API, telas
  afetadas) antes de escrever código.
- **Nunca teste mudanças destrutivas/de schema direto no banco real.** Sempre copie o banco de
  dev para um local isolado, rode a migration e os testes lá primeiro (server numa porta
  alternativa), e só aplique no banco real depois que os testes passarem.
- **Só commit quando eu pedir explicitamente**, mesmo depois de terminar e testar uma feature
  inteira. Não empurre pro git sozinho.
- **Não pare o meu servidor de dev** sem eu pedir, e nunca rode uma ação destrutiva
  (`--force`, `reset --hard`, apagar branch) sem confirmar antes.

## Convenções de código que eu sigo

- **Migrations numeradas globalmente**, uma pasta por migration com `up.sql`/`down.sql`.
  Toda tabela nova tem uma coluna `comment` (TEXT NOT NULL DEFAULT) explicando pra que ela
  serve.
- **SQL direto via better-sqlite3** com prepared statements — sem ORM pesado no meio do
  caminho.
- **Fábricas de rota configuráveis** quando duas entidades compartilham quase toda a lógica
  (ex.: contas a pagar/receber usam a mesma `makeBillsRouter(cfg)`, variando só nomes de
  coluna e direção).
- **Dinheiro sempre em centavos (inteiro)**. Ao dividir um valor em parcelas, o resto da
  divisão inteira vai pra primeira parcela, nunca se perde.
- **Auditoria em toda mutação** (quem fez o quê, valor antes/depois) e **permissão checada em
  toda rota** (`requirePermission`).
- **Alpine.js sem build step**: mixins compartilhados (`table-toolkit.js`) para paginação e
  ordenação; helpers `brl()`/`cents()` pra formatação de moeda; modais como `<dialog>` nativo.
- **Sem comentários óbvios.** Só comento o *porquê* quando não é óbvio pelo código (uma
  regra de negócio escondida, um workaround, uma decisão que outra pessoa acharia estranha à
  primeira vista). Nunca comento o *o quê* — o nome da variável/função já diz isso.
- **Sem abstração prematura.** Três linhas parecidas são melhores que uma abstração
  genérica construída pra um caso hipotético futuro.

## O que eu valorizo numa entrega

- UI polida: paginação de verdade (Primeiro/1,2,3/Último), datas em formato brasileiro,
  ícones nos botões, badges coloridos por status, sem espaços em branco esquisitos.
- Comportamento automático e sensato por padrão, em vez de me forçar a configurar tudo
  manualmente (ex.: rateio de pagamento parcial automático, sem checkbox).
- Testado de ponta a ponta antes de eu considerar "pronto" — não só typecheck, mas o fluxo
  real rodando.
