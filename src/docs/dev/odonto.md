# Módulo Kivo Odonto — Regras de Negócio

Gestão de consultórios e clínicas odontológicas. Reaproveita o Core em vez de duplicar:
paciente é um **cliente** (`customers`) + ficha clínica; procedimento pode apontar para um
produto/serviço do catálogo; a cobrança do tratamento usa o financeiro existente.

A auditoria que fundamenta cada decisão (com `arquivo:linha`) está em
`doc/KIVO_ODONTO_ARCHITECTURE_AUDIT.md`.

## Visão geral

- **Paciente** (`odonto_patients`) é sempre ancorado em `customers` — é para lá que
  `receivables.customer_id` aponta (cobrança do tratamento, convênio, lista de preço).
  Nome, CPF/CNPJ, contato e **data de nascimento** vivem só no cliente: não há duas verdades.
- **Ficha clínica** (`odonto_patient_clinical`) guarda histórico médico/odontológico,
  alergias, medicações e condições. É dado sensível e tem **permissão própria**.
- **Profissionais** (`odonto_professionals`) guardam o CRO — que não fica em `users`, porque
  nem todo profissional tem login e nem todo usuário atende.
- **Procedimentos** (`odonto_procedures`) formam o catálogo clínico, com valor em centavos e
  duração estimada. O vínculo com `products` entra junto com o plano de tratamento.

## Regras que não podem ser quebradas

1. **Excluir paciente não exclui cliente.** A ficha (`odonto_patients` + clínica) recebe soft
   delete; o cadastro em `customers` permanece, para não quebrar histórico de venda,
   recebíveis e convênio.
2. **Clínica ≠ cadastro.** Quem tem só `odonto.patients.*` recebe o cadastro **sem** a chave
   `clinical` na resposta (não é `null`: a chave não existe) e leva 403 ao tentar gravar o
   bloco clínico. A Recepção cadastra, agenda e cobra sem ver prontuário.
3. **Auditoria não copia o conteúdo clínico.** O log registra quem criou/alterou e um sinal
   (`ficha_clinica_criada` / `ficha_clinica_atualizada`), nunca alergias ou histórico — o
   `before_json`/`after_json` do Core serializaria o objeto inteiro.
4. **CPF/CNPJ é único** (validado contra o cadastro de clientes, comparando só os dígitos).
5. **CRO e código de procedimento não se repetem** entre registros ativos.
6. **UF do CRO** é normalizada para maiúsculas e 2 caracteres.

## Interface do módulo: mesmos campos, mesmo respiro, tutorial na primeira entrada

O módulo cresceu em 14 telas escritas em momentos diferentes, e a diferença aparecia para quem
usa. Três coisas passaram a ser regra, com teste que impede a volta (`odonto-interface.ts`):

1. **Campo é campo em qualquer lugar.** O sistema estiliza `.pm-field input` e a classe `.input`;
   filtro de barra de ferramentas e linha de item não estão dentro de `.pm-field`, então todo
   campo solto carrega `class="input"` (119 campos). Checkbox, rádio e seletor de cor ficam
   **nativos** de propósito — não recebem preenchimento de caixa de texto.
2. **Título não cola no parágrafo.** O subtítulo de tela é `.page-subtitle` (definido no partial
   `views/partials/odonto-ui.ejs`, incluído por todas as telas). Acabou a margem negativa que
   apertava o texto contra o `h1`.
3. **Nada vazio sem explicação.** Toda tela de lista tem `partials/empty-state` ou a caixa
   `.odonto-vazio`, que diz o que fazer (e não só "nenhum registro").

**Tutorial** (`views/partials/odonto-tour.ejs`, mesmo motor do PDV e do estoque: `/js/tour.js`):
12 passos explicando o fluxo inteiro — paciente → anamnese → agenda → evolução → odontograma →
plano → cobrança → documentos → painel. Roda **uma vez por máquina** (`KivoTour.autoStart` com a
chave `kivo-tour-odonto-v1`) na primeira tela do módulo que a pessoa abrir, e pode ser revisto no
botão fixo "Rever tutorial".

Dois detalhes que custaram para acertar e ficam registrados:

- o motor **desiste se o alvo do primeiro passo não existir**, e nem toda tela tem o mapa de
  seções — por isso o passo de abertura aponta para `<main>` (existe sempre) e a lista é filtrada
  pelos alvos presentes antes de iniciar;
- o botão é ligado por `addEventListener`, **nunca por `onclick=`**: o CSP da aplicação
  (`script-src` com nonce, sem `unsafe-inline`/`unsafe-hashes`) bloqueia handler inline.

## Documentos e modelos com variáveis (PR §14 e §15)

A §15 pede modelos com variáveis para "não precisar programar cada documento individualmente".
Então o modelo é **conteúdo em texto** (`odonto_document_templates.body`) com `{{variavel}}`, e os
onze tipos da §14 (anamnese, plano/orçamento, TCLE, contrato, atestado, declaração,
encaminhamento, receita, termo de responsabilidade, termo de recusa, alta) vêm **semeados como
conteúdo** — a clínica edita e cria os seus pela tela, sem código novo.

Variáveis disponíveis (`GET /document-variables`): `paciente.nome/cpf/rg/data_nascimento/idade/
sexo/telefone/email/endereco`, `profissional.nome/cro/especialidade`, `data`, `hora`, `data_hora`,
`procedimento`, `consulta.data/hora`, `plano.total`, `plano.itens`. Os dados pessoais vêm do
**cliente** que ancora o paciente (`customers`), como no resto do módulo.

Três decisões que protegem o consultório:

1. **O documento guarda o texto JÁ RENDERIZADO** (snapshot): editar o modelo depois não muda o
   documento que o paciente levou.
2. **Variável sem valor não desaparece**: vira `____________________` para preencher à mão e é
   listada em `missing_variables` — a tela avisa antes de emitir, em vez de imprimir documento
   furado (variável *inexistente* é mantida como `{{...}}` e também reportada).
3. **Emitido não se edita nem se apaga**: a correção é a **versão seguinte** (`replaces_id` /
   `replaced_by_id`), e o documento entregue fica no histórico. Rascunho é livre.

`receita`, `atestado`, `declaração`, `encaminhamento`, `termo de recusa`, `alta` e `contrato`
marcam `requires_professional`: só emitem com profissional **com CRO** (documento clínico sem
CRO não vale). Auditoria registra o ato, o tipo e quantas variáveis ficaram sem valor — nunca o
texto.

**"Exportar em PDF"** é a tela de impressão (`/app/odonto/documentos/:id/imprimir`, folha A4) e o
"Salvar como PDF" do navegador — o mesmo caminho de impressão do cupom, do orçamento e do carnê.
O Electron do Kivo não expõe `printToPDF` (o `preload.ts` está vazio): gerar arquivo `.pdf`
sozinho exigiria uma ponte nova no shell, e não vale ter dois caminhos de impressão no sistema.

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/document-variables` · `/document-templates` | `odonto.documents.view` |
| POST/PUT/DELETE | `/document-templates[/:id]` | `odonto.documents.templates` |
| GET | `/patients/:id/documents?type=` | `odonto.documents.view` |
| POST | `/patients/:id/documents` | `odonto.documents.manage` |
| GET/PUT/DELETE | `/documents/:id` | ver / `odonto.documents.manage` |
| POST | `/documents/:id/issue` · `/cancel` · `/new-version` | `odonto.documents.manage` |

Páginas: `/app/odonto/pacientes/:id/documentos` (lista, geração, ver, emitir, cancelar, versão) e
`/app/odonto/modelos-documentos` (modelos da clínica). Modelo em uso é **desativado**, não
apagado.

## Exames e imagens (PR §16 e §17)

Um exame é **um arquivo** com paciente, data, tipo, descrição e responsável (§16): radiografia,
tomografia, fotografia clínica, documento ou outro. A fotografia ganha a **fase** antes/durante/
depois (§17), e o desenho já guarda isso em coluna própria — a comparação lado a lado que a PR
prevê para o futuro não vai precisar de migração.

**O arquivo não mora no banco.** Fica em `storage/odonto-exams/` e a tabela guarda só a referência
(nome no disco, nome original, mime, tamanho). Mesmo motivo do anexo do financeiro: as tabelas do
módulo sincronizam entre as máquinas da empresa, e uma tomografia em base64 faria cada ciclo de
sync carregar o arquivo inteiro. O nome no disco é um UUID — o nome do consultório nunca vira
caminho de arquivo. O upload chega em base64 no corpo JSON (servidor local/Electron) e o arquivo é
servido por `/uploads/odonto-exams/`.

| Regra | Como ficou |
| --- | --- |
| Formatos | PDF, PNG, JPG/JPEG, WEBP, GIF, BMP — **fora**: SVG e HTML (podem carregar script) e DICOM |
| Tamanho | até **12MB** (radiografia e tomografia passam de 5MB) |
| Excluir | a linha sai por soft delete (fica o rastro de quem apagou) e o **arquivo sai do disco** — é o que libera espaço; arquivo anexado por engano precisa poder sair |
| Trocar o arquivo | grava o novo primeiro e só então remove o antigo |
| Excluir o paciente | linhas em soft delete **e** arquivos removidos |
| Auditoria | registra tipo, fase e tamanho do arquivo; **nunca** o conteúdo |
| Permissão | `odonto.exams.view` (ver/baixar) e `odonto.exams.manage` (anexar/editar/excluir) — exame é dado clínico: a Recepção não vê |

Página: `/app/odonto/pacientes/:id/exames`, com galeria das fotografias agrupada por fase (antes/
durante/depois), lista dos demais arquivos com filtro por tipo, fase e período, prévia antes de
enviar e abertura da imagem em tela cheia.

## Painel, relatórios e auditoria (fase 9, PR §21 e §27)

Página `/app/odonto/painel` (permissão `odonto.reports.view`): pacientes ativos/novos/sem
anamnese, atendimentos de hoje por situação, próximos atendimentos, planos em aberto e valor
previsto, valor cobrado no mês, documentos emitidos e dentes avaliados no odontograma.

Relatórios (`GET /reports/:tipo?from&to`, com `.../csv` para exportar): **atendimentos** (por
situação e por profissional, com faltas), **produção** (procedimentos registrados nas evoluções,
por procedimento e profissional, com valor de tabela), **planos** (por situação e valor),
**documentos** (por tipo, gerados x emitidos), **anamnese** (respostas e pacientes) e
**pacientes** (carteira). O CSV sai com BOM para o Excel abrir acento corretamente.

**Regra que vale para tudo aqui: o painel CONTA e SOMA, nunca mostra texto clínico.** Nenhuma
consulta deste módulo devolve observação de evolução, resposta de anamnese ou corpo de documento
— isso é papel do prontuário, com `odonto.clinical.view` (PR §25). O teste `odonto-painel.ts`
verifica explicitamente que esses textos não aparecem na resposta.

**Auditoria não é reimplementada**: a trilha do Core (`/admin/auditoria`, permissão
`audit.view`) já lista as entidades `odonto_*` como qualquer outra. O painel aponta para lá com
`?q=odonto`, e a tela de auditoria passou a **inicializar o filtro pela URL** (`?q=`) — mudança
pequena e genérica, em vez de uma segunda tela de auditoria.

## Plano de tratamento e cobrança no financeiro (PR §11 e §12)

O plano (migration `0083`) tem itens com **procedimento, dente (FDI), descrição, valor unitário,
quantidade, profissional e situação própria**; o total é `valor × quantidade` somado. Situações
do plano: planejado → apresentado → aprovado → em andamento → concluído, com cancelado saindo de
qualquer uma (e podendo ser reaberto como planejado). Aprovar o plano aprova os itens; concluir
conclui os itens — assim nenhum item fica para trás.

**A PR §12 proíbe financeiro paralelo** ("não criar um segundo financeiro específico para
odontologia"). Então o módulo não tem tabela de cobrança: ao cobrar um plano aprovado, ele chama
o serviço publicado pelo módulo financeiro —

```ts
getService<FinanceReceivablesService>('finance.receivables').create({
  description: `Plano de tratamento #${id} (parcela 1/3)`,
  amountCents, dueDate, customerId, installmentNo, installmentCount,
});
```

— uma conta a receber por parcela, do **cliente que ancora o paciente**, com `installment_no` /
`installment_count` (é o que faz a parcela aparecer na tela "Contas a receber" e no extrato do
cliente). O Odonto guarda só `charged_at`, `installments` e `first_due_date`, para a MESMA
cobrança não sair duas vezes: plano cobrado não tem mais itens editáveis nem pode ser apagado —
o caminho é cancelar (as contas já geradas continuam no Financeiro).

Vencimentos: mensais a partir do primeiro, mantendo o dia (dia 31 cai no fim do mês: 31/01 →
28/02 → 31/03). A divisão é feita em centavos, com o resto na última parcela, para a soma fechar
exatamente o total. Se o módulo Financeiro não estiver ligado na empresa, a parte clínica
funciona e só a cobrança é recusada, com a explicação.

Permissões: `odonto.plans.view` (Dentista, Recepção e Auxiliar — a Recepção cobra),
`odonto.plans.manage` (Dentista) e `odonto.plans.charge` (Dentista e Recepção).

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/patients/:id/treatment-plans` | `odonto.plans.view` |
| POST | `/patients/:id/treatment-plans` | `odonto.plans.manage` |
| GET | `/plans/:id` | `odonto.plans.view` |
| PUT | `/plans/:id` (lista de itens completa) | `odonto.plans.manage` |
| POST | `/plans/:id/status` · `/plans/:id/items/:itemId/status` | `odonto.plans.manage` |
| DELETE | `/plans/:id` (só plano não cobrado e sem item concluído) | `odonto.plans.manage` |
| POST | `/plans/:id/charge` | `odonto.plans.charge` |

Página: `/app/odonto/pacientes/:id/planos`. O **odontograma não duplica** o planejamento: o "P"
no dente e a lista "Tratamento planejado" vêm do plano (`plannedByTooth`), e a tela do
odontograma só registra situação (a antiga opção "tratamento planejado" saiu do formulário).

## Odontograma e situações odontológicas (PR §9 e §10)

Mapa dos dentes na numeração **FDI** (18–11 | 21–28 / 48–41 | 31–38), com cinco faces por dente:
**M** mesial, **D** distal, **O** oclusal/incisal, **V** vestibular, **L** lingual/palatina.
Clique numa face (ou no número do dente, para o dente inteiro) e o painel lateral mostra a
situação atual, o histórico do dente e os procedimentos já realizados (que vêm do prontuário).

Duas decisões que a PR exige:

1. **Situação é catálogo, não lista fixa** (§10: "a arquitetura não deve limitar o sistema a
   uma lista fixa impossível de expandir"). `odonto_tooth_conditions` é tabela: a clínica cria
   "selante", "coroa provisória", o que precisar, com **cor própria** para o desenho. As nove
   iniciais da PR são semeadas no boot. Situação **em uso não é apagada** — é desativada (o
   histórico aponta para ela); sem uso, sai por soft delete.
2. **O estado do dente é histórico append-only.** Registrar de novo **não sobrescreve**: grava
   uma linha nova com data/hora, profissional e CRO do momento. O estado atual é a linha mais
   recente **não desfeita**, e *desfazer* (com quem/quando/motivo) revela o estado anterior sem
   apagar o registro errado — mesma filosofia do prontuário.

`kind` separa **situação** (o que o dente é hoje) de **planejado** (tratamento previsto): o
desenho marca o planejado com um "P", e a fase 6 transforma isso em plano com valor e cobrança.

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/tooth-conditions?active=false` | `odonto.clinical.view` |
| POST | `/tooth-conditions` | `odonto.clinical.edit` |
| PUT/DELETE | `/tooth-conditions/:id` | `odonto.clinical.edit` |
| GET | `/patients/:id/odontogram` | `odonto.clinical.view` |
| GET | `/patients/:id/odontogram/:tooth` (histórico + procedimentos) | `odonto.clinical.view` |
| POST | `/patients/:id/odontogram` | `odonto.clinical.edit` |
| POST | `/odontogram/:stateId/undo` | `odonto.clinical.edit` |

Página: `/app/odonto/pacientes/:id/odontograma`. Dentição decídua fica para depois (a PR diz
"posteriormente"): o campo `tooth` é texto e a validação usa a lista FDI permanente.

## Prontuário: evolução clínica com retificação versionada (PR §7 e §8)

A PR §8 é categórica: **registro clínico não se apaga**. E manda decidir como corrigir ANTES de
criar as tabelas. A decisão (migration `0081`):

1. **Registro vigente é imutável.** Corrigir não altera a linha: cria a versão seguinte
   (`version + 1`) ligada à anterior (`retifica_id`), com **motivo obrigatório** (mínimo 5
   caracteres), autor e data/hora.
2. **A anterior passa a `retificado`** e aponta para quem a substituiu (`replaced_by_id`).
3. **Nada é apagado.** `DELETE /notes/:id` responde **400** explicando que o caminho é a
   retificação — a rota existe para não deixar dúvida. O `deleted_at` só é usado quando o
   PACIENTE inteiro é excluído (soft delete, como o resto do módulo).
4. **A cadeia inteira fica visível**: `GET /notes/:id` devolve `history` com todas as versões
   em ordem, cada uma com autor, data/hora e motivo. A lista do prontuário mostra só a vigente
   (use `?retificadas=1` para ver o histórico junto).
5. **Nome e CRO do profissional são snapshot** do momento do atendimento: registro assinado não
   muda porque o CRO do profissional mudou depois.

Regras de confiança (PR §24.2): o **nome do procedimento vem do catálogo**, nunca do corpo da
requisição, e a **consulta vinculada tem de ser do mesmo paciente**.

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/patients/:id/notes?retificadas=1` | `odonto.clinical.view` |
| POST | `/patients/:id/notes` | `odonto.clinical.edit` |
| GET | `/notes/:id` (registro + cadeia de versões) | `odonto.clinical.view` |
| POST | `/notes/:id/retify` (motivo obrigatório) | `odonto.clinical.retify` |
| DELETE | `/notes/:id` | `odonto.clinical.edit` (responde 400: não existe exclusão) |

Página: `/app/odonto/pacientes/:id/prontuario`, com o mapa de seções do prontuário que a PR §7
pede (Resumo, Anamnese, Prontuário, Odontograma, Tratamentos, Consultas, Documentos, Exames,
Imagens, Financeiro) — as que já existem são link, as futuras aparecem marcadas com a fase.
A permissão nova `odonto.clinical.retify` entra no cargo **Dentista** (só quem assina retifica);
quem tem `odonto.clinical.edit` registra evolução, mas não corrige a assinada.

## Agenda (PR §6)

Agenda do consultório em três visões (**dia**, **semana** e **mês**), com filtro por
profissional e por situação.

Regras que sustentam o dia a dia:

1. **Um profissional não atende dois pacientes no mesmo horário.** Ao agendar ou reagendar, o
   serviço procura sobreposição para aquele profissional e recusa com **409** dizendo com quem
   bate ("já atende Ana das 09:00 às 09:30"). Quem libera o horário é a situação: `cancelado` e
   `faltou` não bloqueiam; `atendido` continua ocupando (o horário existiu).
2. **Encaixe é exceção declarada.** `is_fit_in` permite a sobreposição — é a razão de existir —
   e o histórico registra o evento `encaixe` dizendo sobre quem entrou.
3. **Reagendar move o MESMO agendamento** e grava `reagendado` com o de/para. Não cria linha
   nova: a agenda do dia não vira pilha de cancelados e o histórico de remarcações continua.
4. **Situação anda na ordem**: `agendado → confirmado → em_atendimento → atendido` (com `faltou`
   e `cancelado` no caminho). `atendido` é final; `faltou` e `cancelado` podem voltar para
   `agendado`. Cada mudança carimba a hora (`confirmed_at`, `started_at`, `finished_at`,
   `cancelled_at`) e vira linha em `odonto_appointment_events` (append-only).
5. Atendimento já realizado **não** é reagendado, cancelado nem apagado — o caminho é registrar
   o ocorrido na evolução (Fase 4).

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/appointments?view=dia\|semana\|mes&date=&professional_id=&status=` | `odonto.agenda.view` |
| GET | `/appointments/:id` (com histórico) | `odonto.agenda.view` |
| POST | `/appointments` | `odonto.agenda.manage` |
| PUT | `/appointments/:id` (reagendar/editar) | `odonto.agenda.manage` |
| POST | `/appointments/:id/status` | `odonto.agenda.manage` |
| DELETE | `/appointments/:id` (lançado por engano) | `odonto.agenda.manage` |

Página: `/app/odonto/agenda`. Cargos de fábrica: Dentista e Recepção **gerenciam** a agenda;
Auxiliar só **vê**.

## Anamnese (PR §5)

Questionário clínico **versionado dos dois lados**:

- **Formulário** (`odonto_anamnesis_templates`): publicar uma alteração cria a versão seguinte
  (`v2`, `v3`…). A versão anterior continua na tabela e as respostas dadas nela continuam
  apontando para ela. Um formulário é o **padrão** do consultório (o que abre em "Responder
  anamnese"); o padrão de fábrica é criado no boot com os campos da PR (queixa principal,
  histórico médico, doenças, alergias, medicamentos, hábitos, histórico odontológico) mais a
  triagem usual (gestante, pressão, diabetes, cardiopatia, anticoagulante, cirurgia, última
  consulta).
- **Resposta** (`odonto_anamnesis_forms`): salvar **nunca sobrescreve** — grava a revisão
  seguinte (`revisão 1, 2, 3…`), com data, hora, usuário e profissional responsável. A
  numeração é do **paciente**, não do formulário: publicar uma versão nova no meio do
  acompanhamento não faz a revisão voltar para 1.
- Tipos de pergunta: texto curto, texto longo, sim/não/não sei, escolha única, múltipla
  escolha, data e número. Resposta de pergunta inexistente é **recusada** (400) e pergunta
  obrigatória vazia também — o banco não guarda lixo clínico.
- A exclusão do paciente leva a anamnese junto (soft delete); o histórico continua no banco.

Rotas e telas:

| Método | Rota | Permissão |
| --- | --- | --- |
| GET/POST | `/anamnesis/templates` | `odonto.clinical.view` / `.edit` |
| GET | `/anamnesis/templates/:id` | `odonto.clinical.view` |
| GET/POST | `/patients/:id/anamnesis` | `odonto.clinical.view` / `.edit` |
| GET | `/anamnesis/:id` | `odonto.clinical.view` |

Páginas: `/app/odonto/pacientes/:id/anamnese` (responder, ver a atual e o histórico) e
`/app/odonto/anamnese-modelos` (formulários e versões). A ficha do paciente mostra só o
**resumo** (quantas revisões, quando foi a última) — o conteúdo exige a permissão clínica.

## Permissões

| Permissão | Para quê |
| --- | --- |
| `odonto.patients.view` | Ver lista e ficha cadastral |
| `odonto.patients.create` | Cadastrar paciente |
| `odonto.patients.edit` | Editar cadastro |
| `odonto.patients.delete` | Excluir a ficha (cliente permanece) |
| `odonto.clinical.view` | Ver o conteúdo clínico (alergias, histórico, medicações) |
| `odonto.clinical.edit` | Gravar/alterar o conteúdo clínico |
| `odonto.professionals.view` | Ver profissionais |
| `odonto.professionals.manage` | Cadastrar/editar/excluir profissionais |
| `odonto.procedures.view` | Ver procedimentos |
| `odonto.procedures.manage` | Cadastrar/editar/excluir procedimentos |

O Administrador recebe todas a cada boot. Para Dentista/Recepção/Auxiliar, conceda em
Cargos (ou acrescente aos presets de fábrica — ainda não feito).

## Endpoints (`/api/odonto`)

| Método | Rota | Permissão |
| --- | --- | --- |
| GET | `/patients?q=&active=` | `odonto.patients.view` |
| GET | `/patients/:id` | `odonto.patients.view` (+ `odonto.clinical.view` para o bloco clínico) |
| POST | `/patients` | `odonto.patients.create` (+ `odonto.clinical.edit` se enviar `clinical`) |
| PUT | `/patients/:id` | `odonto.patients.edit` (+ `odonto.clinical.edit` se enviar `clinical`) |
| DELETE | `/patients/:id` | `odonto.patients.delete` |
| GET/POST/PUT/DELETE | `/professionals[/:id]` | `odonto.professionals.view` / `.manage` |
| GET/POST/PUT/DELETE | `/procedures[/:id]` | `odonto.procedures.view` / `.manage` |

Páginas: `/app/odonto/pacientes`, `/app/odonto/pacientes/:id`, `/app/odonto/profissionais`,
`/app/odonto/procedimentos`.

## Integrações

- `commercial.customers` (serviço) — criação/atualização do cliente que ancora o paciente.
  O módulo **não** importa repositório do commercial; a comunicação é pelo registry.
- `odonto.patients` e `odonto.professionals` (serviços publicados) — a agenda vai escolher
  paciente e profissional por aqui.

## Sincronização

**Nada do módulo sincroniza nesta versão** (nenhuma tabela em `syncTables`): dado clínico
fica na máquina que o produziu. Consequência prática: em consultório com dois computadores, o
paciente cadastrado em um **não** aparece no outro. Sincronizar exige antes decidir resolução
de conflito de prontuário e o tratamento do dado sensível na nuvem (ver §19 da auditoria).

## Erros comuns

- **403 "Recurso desativado"** — não é o caso deste módulo (não há capability na v1), mas o
  diálogo global de recursos aparece se o módulo sair do plano da licença: `/api/odonto`
  responde 403 e `/app/odonto` redireciona para a home.
- **401** — sem sessão.
- **409 em paciente** — CPF/CNPJ já cadastrado (a mensagem diz de quem é o cadastro).
- **403 `Permissão negada: odonto.clinical.edit`** — tentou gravar bloco clínico sem a
  permissão clínica. O cadastro continua aceito no mesmo corpo, desde que sem `clinical`.

## Como configurar uma clínica (checklist)

1. **Módulos no painel** (plano da empresa): `odonto` + `commercial` + `finance` são
   obrigatórios (o Odonto depende do Comercial para o cadastro de cliente e o Financeiro
   recebe a cobrança do tratamento). Recomendados: `dre` e `nfe` (entrada de material por
   XML, com lote e validade). `store` entra se a clínica recebe na hora ou emite orçamento;
   `labels`, `fiscal`, `comandas` e `foodservice` não se aplicam a consultório.
   No painel há o atalho **Perfil do segmento → Odontologia**, que pré-marca os módulos.
2. **Recursos (capabilities)** em Configurações › Recursos: `nfe.import` se usar NF-e;
   `commercial.kits` se vender kit (ex.: clareamento caseiro). Os recursos de varejo
   (variantes, complementos, cardápio online, produção) ficam **desligados**.
3. **Cargos** (tela de Cargos): use os de fábrica **Dentista**, **Recepção** e **Auxiliar**.
   A regra é separar cadastro de clínica: Recepção agenda, cadastra e cobra **sem** ver
   prontuário; só Dentista e Auxiliar têm `odonto.clinical.view`.
4. **Cadastros base**, nesta ordem: categorias de material, formas de pagamento,
   profissionais (com CRO), procedimentos (valor e duração).
5. **Pacientes** por último — cada paciente cria também um cliente no Comercial.

Detalhe prático: não conceda `commercial.customers.*` à Recepção. O cadastro de paciente
funciona sem isso (a ponte é feita pelo serviço interno `commercial.customers`); a permissão
do Comercial só é necessária para o atalho "Financeiro do paciente" na ficha.

## Ambiente de teste: a clínica de exemplo

O dentista que instala o Kivo não tem como avaliar o módulo com as telas vazias — e o catálogo de
demonstração do assistente de boas-vindas cria só PRODUTOS (procedimentos e material). Por isso
existe um gerador da clínica inteira:

- **Onde:** card **Ambiente de teste do Odonto**, no fim da tela inicial (só para quem tem
  `settings.edit`), e também no fim do assistente de boas-vindas quando o ramo é
  **Odontologia / clínica**. As duas portas chamam a mesma coisa (`createOdontoDemoData`).
- **O que cria:** 4 profissionais, 10 pacientes (com cliente no Comercial e ficha clínica), 10
  procedimentos, anamnese respondida, agenda em torno do dia de hoje (atendido, faltou,
  confirmado, agendado, em atendimento e cancelado), odontograma com situação e planejado, 4
  planos em estados diferentes, documentos emitidos e em rascunho, prontuário **com um par de
  retificação** e 6 exames — 5 com imagem e 1 laudo em PDF.
- **As imagens nascem em código** (`demoImages.ts`): PNG desenhado na hora (panorâmica,
  periapical, tomografia e fotos antes/depois) e um PDF de laudo. Nada de arquivo de imagem no
  repositório nem base64 gigante no fonte.
- **É idempotente:** rodar de novo completa o que faltar, sem duplicar (chave natural: nome,
  código, título, paciente + horário). A agenda é relativa a HOJE, então rodar em outro dia
  acrescenta a semana nova — é o que "regenerar" significa.
- **Nunca encosta em paciente real:** se já existir um cliente com o mesmo nome e sem a marca da
  demonstração, aquele paciente de exemplo é **pulado** (e contado no resumo). Os pacientes
  criados levam a marca em `notes`.
- **Como apagar:** Configurações → Avançado → **Recomeçar do zero** (zona de perigo). Ele apaga
  tudo — exemplo e real —, tira backup antes, limpa a nuvem e agora também **apaga os arquivos de
  exame do disco** (`clearExamFilesDir`), que antes ficavam órfãos depois de cada reset.

## Roadmap da PR: concluído

Todas as fases da PR estão implementadas: fundação (1), pacientes + anamnese (2), agenda (3),
prontuário/evolução com retificação versionada (4), odontograma + situações (5), plano de
tratamento + cobrança no financeiro (6), documentos com modelos e variáveis (7), exames e imagens
(8) e painel/relatórios/auditoria (9).

Fora de escopo por decisão registrada: **assinatura eletrônica** de documento/contrato (o PDF é
anexado, não assinado dentro do sistema), **reajuste anual automático** de contrato e **dentição
decídua** (a PR diz "posteriormente"; o campo do dente é texto e a validação usa a lista FDI
permanente).

## Arquivos-chave

- `src/modules/odonto/module.manifest.ts` — permissões, menu, dependências.
- `src/modules/odonto/permissions.ts` — permissões clínicas e `Result` (evita ciclo entre
  paciente e anamnese).
- `src/modules/odonto/patients.ts` — regras do paciente e do bloco clínico.
- `src/modules/odonto/anamnesis.ts` — formulários versionados, validação das respostas e
  revisões imutáveis.
- `src/modules/odonto/appointments.ts` — agenda: conflito de horário, encaixe, transições de
  situação e histórico do atendimento.
- `src/modules/odonto/clinicalNotes.ts` — prontuário: evolução clínica, retificação versionada e
  a recusa explícita de apagar registro clínico.
- `src/modules/odonto/odontogram.ts` — odontograma: catálogo de situações e estado do dente por
  face em histórico append-only (com desfazer que revela o anterior).
- `src/modules/odonto/documents.ts` — documentos: motor de variáveis, modelos, emissão, versões e
  a marcação do que ficou sem valor.
- `src/modules/odonto/reports.ts` — painel e relatórios: só contagem e soma, sem texto clínico.
- `src/modules/odonto/demoData.ts` — clínica de exemplo (idempotente, não encosta em paciente real).
- `src/modules/odonto/demoImages.ts` — imagens e laudo da demonstração, desenhados em código.
- `src/tests/odonto-demo.ts` — teste da demonstração (cobertura, idempotência, PNG íntegro,
  proteção do paciente real e limpeza dos arquivos).
- `src/modules/odonto/professionals.ts` / `procedures.ts` — CRUD com validação e auditoria.
- `src/modules/odonto/repositories/` — SQL (paciente faz `JOIN` com `customers`).
- `src/modules/odonto/migrations/0078_odonto_base/` — tabelas da fundação.
- `src/modules/commercial/customers.ts` — serviço `commercial.customers` (âncora do paciente).
- `src/tests/odonto-patients.ts` — teste de integração (rode com `node scripts/test-isolated.js`).
