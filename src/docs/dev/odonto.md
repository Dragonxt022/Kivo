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

## Próximas fases (roadmap da PR)

Prontuário/evolução com retificação versionada (4), odontograma (5),
plano de tratamento + cobrança (6), documentos com variáveis (7), exames e imagens (8),
refinamento (9). As capabilities de cada recurso entram junto com a tela — não antes.

Concluído: fundação (1), pacientes + anamnese (2) e agenda (3).

## Arquivos-chave

- `src/modules/odonto/module.manifest.ts` — permissões, menu, dependências.
- `src/modules/odonto/permissions.ts` — permissões clínicas e `Result` (evita ciclo entre
  paciente e anamnese).
- `src/modules/odonto/patients.ts` — regras do paciente e do bloco clínico.
- `src/modules/odonto/anamnesis.ts` — formulários versionados, validação das respostas e
  revisões imutáveis.
- `src/modules/odonto/appointments.ts` — agenda: conflito de horário, encaixe, transições de
  situação e histórico do atendimento.
- `src/modules/odonto/professionals.ts` / `procedures.ts` — CRUD com validação e auditoria.
- `src/modules/odonto/repositories/` — SQL (paciente faz `JOIN` com `customers`).
- `src/modules/odonto/migrations/0078_odonto_base/` — tabelas da fundação.
- `src/modules/commercial/customers.ts` — serviço `commercial.customers` (âncora do paciente).
- `src/tests/odonto-patients.ts` — teste de integração (rode com `node scripts/test-isolated.js`).
