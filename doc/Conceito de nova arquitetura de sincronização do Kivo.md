# Kivo — Arquitetura Cloud Master + Bancos Locais Offline

## 1. Objetivo

O Kivo atualmente possui uma arquitetura na qual o computador local exerce um papel muito importante na operação e na sincronização com o Cloud.

Queremos evoluir essa arquitetura sem quebrar os clientes atuais.

O novo conceito é:

> **O Kivo Cloud passa a ser o banco de dados Master da empresa, enquanto cada aplicação instalada possui sua própria cópia local dos dados para continuar funcionando mesmo sem internet.**

O computador local deixa de ser o "servidor" da empresa.

Cada computador passa a ser apenas um dispositivo do Kivo conectado à mesma empresa/conta no Cloud.

---

# 2. Conceito principal

A arquitetura desejada é:

```text
                         KIVO CLOUD
                    ┌─────────────────┐
                    │   Banco Master  │
                    │                 │
                    │ Empresa         │
                    │ Produtos        │
                    │ Clientes        │
                    │ Vendas          │
                    │ Estoque         │
                    │ Financeiro      │
                    │ Configurações   │
                    └────────┬────────┘
                             │
                       API / Sync
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
         Computador       Computador       Computador
             1                2                3
            │                │                │
        Banco local      Banco local      Banco local
            │                │                │
            └────────────────┼────────────────┘
                             │
                         MESMA EMPRESA
```

Cada computador possui sua própria base local.

Não devemos fazer computadores diferentes compartilharem diretamente um mesmo arquivo de banco local.

Cada instalação deve funcionar de forma independente.

---

# 3. O Cloud passa a ser o Master

O Kivo Cloud será a fonte central dos dados consolidados.

Ele deve permitir que diferentes dispositivos da mesma empresa compartilhem informações sem que um computador específico precise estar ligado.

Exemplo:

Uma empresa possui:

- PDV 01
- PDV 02
- Computador administrativo

Todos pertencem ao mesmo ambiente/empresa no Kivo Cloud.

O Cloud representa o estado central da empresa.

```text
Empresa A
     │
     ├── PDV 01
     ├── PDV 02
     └── Administrativo
```

Se o PDV 01 estiver desligado, o PDV 02 continua podendo sincronizar com o Cloud.

Se o computador administrativo estiver desligado, o Cloud continua disponível.

Nenhum computador deve ser considerado o servidor central da empresa.

---

# 4. O banco local continua existindo

Não queremos transformar o Kivo em um sistema exclusivamente online.

A operação offline continua sendo um requisito fundamental.

Cada instalação deve possuir sua própria base local.

Essa base permite que o sistema continue funcionando quando:

- a internet cair;
- o servidor estiver temporariamente indisponível;
- o computador estiver sem conexão;
- houver instabilidade de rede.

O usuário deve conseguir continuar trabalhando normalmente.

A internet não pode ser um requisito para a operação básica do PDV.

---

# 5. O banco local não é o Master

É importante estabelecer claramente a diferença:

### Cloud

É o Master e o ponto central de sincronização.

### Banco local

É a cópia operacional daquela instalação.

Portanto:

```text
Cloud
= fonte central

Banco local
= cópia operacional offline
```

O banco local não deve ser tratado como a única fonte dos dados da empresa.

---

# 6. Sincronização bidirecional

A sincronização deve funcionar nos dois sentidos.

## Computador → Cloud

Quando uma operação acontece localmente:

```text
Venda realizada
        ↓
Banco local
        ↓
Sincronização
        ↓
Cloud
```

## Cloud → Computador

Quando uma alteração é realizada em outro dispositivo ou no painel Web:

```text
Alteração no Cloud
        ↓
Sincronização
        ↓
Banco local
        ↓
Aplicação atualizada
```

Portanto, o fluxo deve ser:

```text
LOCAL ↔ CLOUD
```

e não apenas:

```text
LOCAL → CLOUD
```

---

# 7. Exemplo com múltiplos computadores

Imagine uma empresa com três computadores.

```text
Empresa 001

PDV 01
PDV 02
Administrativo
```

O PDV 01 registra uma venda.

A operação é registrada localmente.

Depois, quando houver conexão:

```text
PDV 01
   ↓
Cloud
```

O Cloud passa a conhecer essa venda.

O PDV 02 e o computador administrativo poderão receber essa alteração:

```text
                    Cloud
                      │
             ┌────────┴────────┐
             ↓                 ↓
          PDV 02          Administrativo
```

Nenhum dos dois precisa acessar diretamente o banco do PDV 01.

---

# 8. Operação offline

Suponha que a internet da empresa caia.

O PDV continua funcionando.

Exemplo:

```text
Internet OFF

Cliente compra
      ↓
PDV
      ↓
Banco local
      ↓
Venda registrada
```

A venda fica aguardando sincronização.

Quando a internet retornar:

```text
Internet ON
      ↓
Sincronização
      ↓
Cloud
```

Depois disso, os demais dispositivos recebem as informações.

O usuário não deve precisar fazer uma exportação/importação manual.

---

# 9. A sincronização deve ser baseada em eventos/operações

Não queremos simplesmente comparar bancos inteiros constantemente.

A sincronização deve saber **o que aconteceu**.

Exemplos conceituais:

```text
sale.created
sale.cancelled

product.created
product.updated

customer.created
customer.updated

stock.increased
stock.decreased
stock.adjusted

payment.created
payment.cancelled
```

Cada alteração relevante deve poder ser identificada como uma operação/evento de sincronização.

Isso permite saber:

- o que mudou;
- onde mudou;
- quando mudou;
- qual dispositivo realizou a mudança;
- se já foi sincronizado;
- se ainda está pendente;
- se precisa ser processado novamente.

---

# 10. Identificação dos dispositivos

Cada instalação do Kivo deve possuir uma identidade própria.

Por exemplo, conceitualmente:

```text
Empresa: 001

Dispositivo:
PDV-01

Dispositivo:
PDV-02

Dispositivo:
ADMIN-01
```

O Cloud precisa conseguir identificar de qual dispositivo uma alteração veio.

Isso será importante para:

- sincronização;
- auditoria;
- conflitos;
- segurança;
- diagnóstico;
- controle de dispositivos;
- suporte.

---

# 11. Controle de sincronização

Cada dispositivo deve saber até onde conseguiu sincronizar.

O objetivo é evitar que o sistema precise baixar novamente todos os dados a cada sincronização.

Conceitualmente:

```text
PDV 01
Última sincronização: evento 10582

PDV 02
Última sincronização: evento 10579

ADMIN 01
Última sincronização: evento 10582
```

Quando o dispositivo voltar a sincronizar, ele solicita somente aquilo que ainda não recebeu.

---

# 12. Outbox local

Cada aplicação deve possuir uma fila local de operações pendentes.

Quando o usuário realiza uma operação offline:

```text
Venda
 ↓
Banco local
 ↓
Evento pendente
```

Esse evento permanece armazenado até ser confirmado pelo Cloud.

Isso evita perder operações caso:

- a internet caia;
- o aplicativo seja fechado;
- o computador seja reiniciado;
- o processo de sincronização seja interrompido.

A sincronização deve ser resiliente.

---

# 13. Confirmação de entrega

Uma operação não deve ser considerada sincronizada simplesmente porque foi enviada.

Ela deve ser considerada sincronizada quando houver confirmação de processamento pelo destino.

Conceitualmente:

```text
Pendente
   ↓
Enviando
   ↓
Recebido
   ↓
Processado
   ↓
Confirmado
```

Se houver erro:

```text
Pendente
   ↓
Tentativa
   ↓
Erro
   ↓
Retry
   ↓
Nova tentativa
```

O sistema deve conseguir recuperar operações sem intervenção manual sempre que possível.

---

# 14. Idempotência

A sincronização precisa suportar a possibilidade de uma mesma operação ser enviada mais de uma vez.

Exemplo:

```text
PDV envia venda
       ↓
Cloud processa
       ↓
Conexão cai antes da confirmação
       ↓
PDV envia novamente
```

O Cloud não pode criar uma segunda venda.

A operação deve possuir uma identificação única que permita reconhecer:

> "Essa operação já foi processada."

Esse conceito é obrigatório para a confiabilidade da sincronização.

---

# 15. Retry

Falhas temporárias não devem significar perda de dados.

Se uma sincronização falhar:

```text
Tentativa 1
   ↓
Falhou

Tentativa 2
   ↓
Falhou

Tentativa 3
   ↓
Sucesso
```

O sistema deve controlar as tentativas e permitir recuperação automática.

Operações que não puderem ser processadas após várias tentativas devem ficar identificadas como problemas de sincronização para diagnóstico.

---

# 16. Conflitos

Como vários computadores podem operar simultaneamente, precisamos considerar conflitos.

Exemplo:

```text
PC 01 — offline
Produto X → preço R$ 10

PC 02 — online
Produto X → preço R$ 12
```

Quando o PC 01 voltar a sincronizar, existirão duas alterações.

O sistema precisa possuir regras claras para determinar como cada tipo de dado será tratado.

Não devemos simplesmente sobrescrever informações indiscriminadamente.

---

# 17. Vendas e movimentações financeiras

Operações históricas como vendas, pagamentos e movimentações financeiras devem ser tratadas com muito cuidado.

A preferência deve ser registrar a operação realizada, e não simplesmente sobrescrever um valor final.

Exemplo conceitual:

```text
Venda criada
Pagamento registrado
Venda cancelada
```

Isso permite manter histórico e auditoria.

---

# 18. Estoque

O estoque merece tratamento especial.

Não devemos depender apenas de:

```text
estoque = 50
```

como informação de sincronização.

O sistema deve conseguir representar as movimentações:

```text
Entrada +20
Venda -2
Perda -1
Ajuste +5
```

Isso permite que diferentes dispositivos sincronizem operações de estoque com muito mais segurança.

---

# 19. O painel Web não depende mais do computador

Essa é uma das principais mudanças.

Hoje, a preocupação é que o computador precise estar ligado para que determinadas informações cheguem ao Cloud.

No novo modelo:

```text
Usuário
   ↓
Kivo Web
   ↓
Kivo Cloud
   ↓
Banco Master
```

O computador da empresa pode estar desligado.

O painel Web continuará funcionando com os dados que já foram sincronizados com o Cloud.

Isso transforma o Cloud em uma verdadeira plataforma SaaS.

---

# 20. Recuperação de um computador

Uma das grandes vantagens da nova arquitetura será a recuperação.

Imagine que um computador seja perdido ou substituído.

Instala-se o Kivo em outro computador.

O novo dispositivo é vinculado à empresa.

Então:

```text
Kivo Cloud
     ↓
Sincronização inicial
     ↓
Banco local
     ↓
Aplicação pronta
```

O cliente não depende do computador antigo para recuperar os dados que já foram sincronizados.

---

# 21. Segurança

A sincronização deve respeitar rigorosamente a empresa/tenant.

Um dispositivo de uma empresa jamais pode receber dados de outra empresa.

Toda operação deve estar associada à empresa correta.

O Cloud deve validar:

- identidade;
- empresa;
- dispositivo;
- permissões;
- autenticidade da operação;
- origem da operação.

Nunca devemos confiar apenas nas informações enviadas pelo cliente.

---

# 22. Não utilizar broker neste primeiro momento

Não é necessário introduzir um broker neste estágio.

A primeira versão pode utilizar:

```text
Cloud
+
API
+
controle de eventos
+
fila persistente
+
workers
+
Outbox
+
Inbox/idempotência
+
Retry
```

A arquitetura deve, entretanto, ser organizada de maneira que futuramente possa receber um broker caso o volume do Kivo exija.

O objetivo agora é manter a infraestrutura simples e confiável.

---

# 23. Não alterar o funcionamento dos clientes atuais de uma vez

Já existem clientes utilizando o Kivo em produção.

Portanto, essa mudança deve ser feita de maneira incremental.

Não devemos simplesmente substituir toda a arquitetura atual.

A prioridade é:

1. manter os clientes atuais funcionando;
2. construir a nova camada de sincronização;
3. testar em ambiente controlado;
4. escolher um cliente piloto;
5. validar todas as operações;
6. somente depois expandir para os demais clientes.

A compatibilidade e a segurança dos dados existentes são prioridades.

---

# 24. Futuro multiplataforma

Essa arquitetura não deve ser construída pensando somente no Desktop.

O objetivo é criar um protocolo de sincronização independente da interface.

No futuro poderemos ter:

```text
                 KIVO CLOUD
                     │
                Sync Protocol
                     │
       ┌─────────────┼─────────────┐
       │             │             │
    Desktop          PWA         Mobile
    SQLite        IndexedDB       API
```

O Desktop pode utilizar SQLite.

Um futuro PWA pode utilizar IndexedDB.

Um aplicativo mobile pode utilizar seu próprio armazenamento local ou trabalhar diretamente com a API, conforme a necessidade.

Todos podem conversar com o mesmo Cloud.

Portanto:

> **SQLite não deve ser considerado o mecanismo de sincronização. Ele é apenas o armazenamento local do Desktop.**

O verdadeiro mecanismo deve ser o protocolo de sincronização do Kivo.

---

# 25. Arquitetura conceitual final

O objetivo final é:

```text
                         KIVO CLOUD
                  ┌─────────────────────┐
                  │                     │
                  │     MySQL Master    │
                  │                     │
                  │     Kivo API        │
                  │                     │
                  │     Sync Engine     │
                  │                     │
                  │     Event System     │
                  │                     │
                  └──────────┬──────────┘
                             │
                        Sync Protocol
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
     Kivo Desktop        Kivo Web          Futuro PWA
          │                  │                  │
       SQLite              Cloud            IndexedDB
          │
       Offline
          │
          └─────────────── Sync ────────────────┘
```

---

# 26. Princípio fundamental

O novo Kivo deve seguir esta lógica:

> **Cloud First, Offline Capable.**

O Cloud é a fonte central e consolidada.

As aplicações possuem armazenamento local para garantir continuidade operacional.

A sincronização mantém os dois mundos alinhados.

O computador local não é mais o servidor da empresa.

Cada dispositivo é um cliente independente da mesma empresa.

---

# 27. Resultado esperado

Ao final da evolução, uma empresa poderá ter:

```text
Empresa X
│
├── Kivo Desktop — PDV 01
│      └── banco local
│
├── Kivo Desktop — PDV 02
│      └── banco local
│
├── Kivo Desktop — Administrativo
│      └── banco local
│
└── Kivo Cloud
       └── banco Master
```

Todos trabalham de maneira independente quando necessário.

Todos sincronizam com o mesmo Cloud.

O painel Web funciona independentemente dos computadores estarem ligados.

Uma venda feita em um dispositivo pode chegar aos demais.

Uma alteração feita no Cloud pode chegar aos dispositivos.

Uma falha de internet não interrompe a operação.

Uma falha em um computador não significa perda dos dados já sincronizados.

E uma nova instalação pode reconstruir sua base local a partir do Cloud.

---

# 28. Regra de ouro da implementação

A implementação deve preservar três características:

### 1. Offline First

O usuário não pode depender da internet para continuar trabalhando.

### 2. Cloud Master

O Cloud deve ser a fonte central dos dados da empresa.

### 3. Sync Reliable

Nenhuma operação deve ser perdida, duplicada ou silenciosamente ignorada.

O objetivo não é apenas "sincronizar bancos".

O objetivo é construir um **sistema distribuído confiável**, no qual diferentes instalações do Kivo possam trabalhar simultaneamente, mesmo com períodos de desconexão, e posteriormente convergir para um estado consistente no Cloud.

---

## Resultado comercial esperado

Com essa arquitetura, o Kivo deixa de ser conceitualmente:

> "Um sistema instalado em um computador que possui sincronização com a nuvem."

E passa a ser:

> **"Um sistema de gestão em nuvem que funciona offline em cada dispositivo e mantém todos os seus dispositivos sincronizados."**

Essa deve ser a direção arquitetural da próxima evolução do Kivo.