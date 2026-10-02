# PR — Kivo Odonto

**Projeto:** Kivo  
**Módulo:** Odontologia  
**Nome interno:** Kivo Odonto  
**Status:** Planejamento  
**Versão inicial:** 1.0  
**Objetivo:** Criar um módulo especializado para gestão de consultórios e clínicas odontológicas, integrado à arquitetura existente do Kivo.

---

# 1. Objetivo do projeto

Desenvolver o **Kivo Odonto**, um módulo especializado para dentistas, consultórios e clínicas odontológicas.

O módulo deverá combinar:

- Gestão administrativa;
- Agenda;
- Cadastro de pacientes;
- Anamnese;
- Prontuário odontológico;
- Odontograma;
- Evolução clínica;
- Plano de tratamento;
- Procedimentos;
- Documentos;
- Exames e imagens;
- Financeiro;
- Controle de usuários e permissões.

A premissa principal é **reaproveitar a infraestrutura e os módulos genéricos já existentes no Kivo**, adicionando uma camada clínica específica para odontologia.

O objetivo não é criar um sistema completamente separado, mas transformar o Kivo em uma plataforma modular capaz de atender diferentes segmentos.

---

# 2. Princípio arquitetural

O Kivo possui uma filosofia central:

> **"Ligue somente o que você precisa."**

O Kivo Odonto deve seguir essa mesma filosofia.

A arquitetura deverá separar:

```text
KIVO CORE
│
├── Empresas
├── Usuários
├── Permissões
├── Financeiro
├── Caixa
├── Estoque
├── Pessoas
├── Relatórios
├── Configurações
└── Agenda
        │
        └── KIVO ODONTO
              ├── Pacientes
              ├── Anamnese
              ├── Prontuário
              ├── Odontograma
              ├── Evolução
              ├── Tratamentos
              ├── Procedimentos
              ├── Documentos
              ├── Exames
              └── Imagens
```

O módulo odontológico deverá depender do Core sempre que uma funcionalidade já existente atender à necessidade.

Não duplicar:

- usuários;
- empresas;
- financeiro;
- estoque;
- autenticação;
- permissões;
- configurações;
- infraestrutura.

---

# 3. Público-alvo

O módulo deverá atender inicialmente:

### Profissionais

- Dentistas autônomos;
- Consultórios odontológicos;
- Clínicas odontológicas;
- Clínicas com vários dentistas.

### Equipe

- Dentistas;
- Auxiliares;
- Técnicos;
- Recepcionistas;
- Administradores.

A primeira versão deverá priorizar consultórios pequenos e médios.

---

# 4. Escopo da versão 1.0

A versão inicial deverá conter:

## 4.1 Pacientes

Cadastro completo de pacientes.

### Dados pessoais

- Nome completo;
- CPF;
- RG;
- Data de nascimento;
- Sexo;
- Telefone;
- WhatsApp;
- E-mail;
- Endereço;
- Foto;
- Observações.

### Informações odontológicas

- Histórico odontológico;
- Histórico médico;
- Alergias;
- Medicamentos;
- Condições relevantes;
- Observações clínicas.

---

# 5. Anamnese

Criar estrutura para anamnese odontológica.

O sistema deverá permitir:

- Criar formulário;
- Responder formulário;
- Salvar respostas;
- Consultar histórico;
- Atualizar formulário sem apagar respostas anteriores.

A anamnese deverá possuir estrutura flexível para permitir evolução futura.

Exemplos:

- Histórico médico;
- Doenças;
- Alergias;
- Medicamentos;
- Hábitos;
- Histórico odontológico;
- Queixa principal.

As respostas devem ficar vinculadas ao paciente e possuir:

- Data;
- Hora;
- Usuário/profissional responsável.

---

# 6. Agenda

Criar agenda específica para atendimento odontológico.

A agenda deverá permitir:

- Visualização diária;
- Visualização semanal;
- Visualização mensal;
- Agendamento;
- Reagendamento;
- Cancelamento;
- Encaixe;
- Confirmação;
- Registro de falta;
- Registro de atendimento.

### Status

- Agendado;
- Confirmado;
- Em atendimento;
- Atendido;
- Faltou;
- Cancelado.

### Informações do agendamento

- Paciente;
- Profissional;
- Data;
- Horário;
- Duração;
- Procedimento;
- Observação;
- Sala/cadeira, quando aplicável.

---

# 7. Prontuário odontológico

O prontuário será um dos componentes centrais do Kivo Odonto.

A tela do paciente deverá apresentar uma visão organizada do histórico.

Estrutura inicial:

```text
Paciente
│
├── Resumo
├── Anamnese
├── Prontuário
├── Odontograma
├── Tratamentos
├── Consultas
├── Documentos
├── Exames
├── Imagens
└── Financeiro
```

---

# 8. Evolução clínica

Cada atendimento poderá gerar um registro de evolução.

Cada registro deverá possuir:

- Paciente;
- Profissional;
- CRO;
- Data;
- Hora;
- Consulta;
- Procedimentos realizados;
- Observações;
- Diagnóstico, quando aplicável;
- Conduta;
- Próximos passos;
- Documentos relacionados;
- Exames relacionados.

O sistema deverá preservar o histórico.

### Regra importante

Registros clínicos não devem ser simplesmente apagados.

Quando houver necessidade de correção, deverá existir mecanismo de:

- Retificação;
- Histórico;
- Registro do usuário;
- Data/hora;
- Motivo da alteração, quando necessário.

A implementação deverá ser definida antes da criação definitiva das tabelas.

---

# 9. Odontograma

Criar odontograma visual interativo.

O sistema deverá representar os dentes permanentes e, posteriormente, permitir suporte a dentição decídua.

Cada dente deverá possuir identificação.

Exemplo:

```text
18 17 16 15 14 13 12 11
21 22 23 24 25 26 27 28

48 47 46 45 44 43 42 41
31 32 33 34 35 36 37 38
```

O usuário deverá conseguir selecionar um dente.

Cada dente poderá possuir:

- Situação;
- Procedimentos;
- Observações;
- Histórico;
- Tratamentos planejados;
- Tratamentos realizados.

Deverá existir suporte a superfícies dentárias.

Exemplo:

- Mesial;
- Distal;
- Oclusal;
- Vestibular;
- Lingual/palatina.

---

# 10. Situações odontológicas

A arquitetura não deve limitar o sistema a uma lista fixa impossível de expandir.

Inicialmente poderão existir situações como:

- Íntegro;
- Cárie;
- Restaurado;
- Ausente;
- Fratura;
- Tratamento endodôntico;
- Implante;
- Coroa;
- Extração indicada.

A estrutura deverá permitir novas situações futuramente.

---

# 11. Plano de tratamento

O dentista deverá conseguir criar um plano de tratamento para o paciente.

Exemplo:

```text
PLANO DE TRATAMENTO

16 — Restauração
26 — Tratamento de canal
26 — Coroa

Valor total: R$ 2.350,00
```

Cada item deverá possuir:

- Procedimento;
- Dente;
- Descrição;
- Valor;
- Quantidade;
- Profissional;
- Status.

### Status

- Planejado;
- Apresentado;
- Aprovado;
- Em andamento;
- Concluído;
- Cancelado.

---

# 12. Integração com financeiro

Um dos principais objetivos do Kivo Odonto é evitar duplicação entre o sistema clínico e o financeiro.

Quando um plano de tratamento for aprovado, deverá ser possível gerar automaticamente uma cobrança.

Exemplo:

```text
Plano de tratamento
        ↓
Tratamento aprovado
        ↓
Financeiro
        ↓
Conta/parcelamento
        ↓
Pagamento
```

O sistema deverá aproveitar o módulo financeiro existente do Kivo sempre que possível.

Não criar um segundo financeiro específico para odontologia.

---

# 13. Procedimentos

Criar cadastro de procedimentos odontológicos.

Cada procedimento poderá possuir:

- Nome;
- Código interno;
- Descrição;
- Valor padrão;
- Duração estimada;
- Categoria;
- Status;
- Profissional habilitado, quando necessário.

O cadastro deverá permitir posteriormente trabalhar com códigos e referências utilizadas no setor odontológico, sem acoplar a primeira versão a uma tabela externa específica.

---

# 14. Documentos

Criar sistema de documentos vinculados ao paciente.

Documentos inicialmente previstos:

- Anamnese;
- Plano de tratamento;
- TCLE;
- Contrato;
- Atestado;
- Declaração;
- Encaminhamento;
- Receita;
- Termo de responsabilidade;
- Termo de recusa;
- Alta;
- Outros documentos personalizados.

Os documentos deverão poder ser:

- Gerados;
- Visualizados;
- Impressos;
- Exportados em PDF;
- Vinculados ao paciente;
- Vinculados à consulta.

---

# 15. Templates de documentos

Criar estrutura de templates.

Exemplo:

```text
TEMPLATE
│
├── Nome
├── Tipo
├── Conteúdo
├── Variáveis
└── Status
```

Variáveis automáticas:

```text
{{paciente.nome}}
{{paciente.cpf}}
{{paciente.data_nascimento}}
{{profissional.nome}}
{{profissional.cro}}
{{data}}
{{hora}}
{{procedimento}}
```

Isso permitirá criar documentos sem precisar programar cada documento individualmente.

---

# 16. Exames

Criar área para armazenamento de exames.

Tipos:

- Radiografia;
- Tomografia;
- Fotografias;
- Documentos;
- Outros.

Cada arquivo deverá possuir:

- Paciente;
- Data;
- Tipo;
- Descrição;
- Arquivo;
- Usuário responsável.

---

# 17. Fotografias clínicas

Criar suporte para fotografias vinculadas ao paciente.

Possibilidades:

```text
Paciente
│
├── Antes
├── Durante
└── Depois
```

Também permitir:

- Data;
- Procedimento;
- Descrição;
- Profissional.

O recurso deverá ser preparado para evolução futura com comparação de imagens.

---

# 18. Estoque

O Kivo Odonto deverá utilizar o estoque existente no Kivo.

Não criar estoque independente.

Produtos poderão ser classificados como:

- Material odontológico;
- Material descartável;
- Medicamento;
- Equipamento;
- Outros.

No futuro poderá existir consumo automático por procedimento.

Exemplo:

```text
Procedimento:
Restauração

Consumo:
- Resina
- Ácido
- Adesivo
- Luvas
- Máscara
```

Esse recurso não é obrigatório na versão 1.0.

---

# 19. Usuários e permissões

Utilizar o sistema de permissões existente no Kivo.

Criar permissões específicas para odontologia.

Exemplo:

### Administrador

Acesso total.

### Dentista

- Pacientes;
- Prontuários;
- Odontograma;
- Anamnese;
- Tratamentos;
- Documentos;
- Agenda;
- Financeiro conforme permissão.

### Recepcionista

- Cadastro;
- Agenda;
- Atendimento;
- Financeiro permitido.

Não deverá possuir acesso irrestrito ao conteúdo clínico.

### Auxiliar

Acesso definido pela clínica.

---

# 20. Auditoria

Dados clínicos devem possuir rastreabilidade.

Registrar, quando aplicável:

- Usuário;
- Data;
- Hora;
- Ação;
- Registro afetado;
- Alteração realizada.

Especial atenção para:

- Prontuário;
- Evolução;
- Odontograma;
- Anamnese;
- Documentos;
- Tratamentos.

---

# 21. Dashboard

Criar dashboard específico para odontologia.

Indicadores iniciais:

- Consultas de hoje;
- Consultas futuras;
- Pacientes atendidos;
- Pacientes aguardando;
- Tratamentos em andamento;
- Tratamentos concluídos;
- Faturamento;
- Contas em aberto;
- Retornos próximos.

O dashboard deverá utilizar dados dos módulos existentes sempre que possível.

---

# 22. Fluxo principal

O fluxo principal esperado será:

```text
Cadastro da clínica
        ↓
Cadastro do profissional
        ↓
Cadastro do paciente
        ↓
Anamnese
        ↓
Agendamento
        ↓
Atendimento
        ↓
Prontuário
        ↓
Odontograma
        ↓
Plano de tratamento
        ↓
Aprovação
        ↓
Financeiro
        ↓
Pagamento
        ↓
Retorno
```

---

# 23. Arquitetura de dados

A arquitetura deverá evitar criar uma estrutura monolítica específica para odontologia.

Entidades genéricas deverão permanecer no Core.

Entidades específicas deverão pertencer ao módulo Odonto.

Exemplo conceitual:

```text
CORE

Company
User
Role
Permission
Customer/Person
FinancialAccount
Payment
Product
Stock
Appointment


ODONTO

Patient
MedicalHistory
DentalHistory
Anamnesis
ClinicalRecord
DentalChart
Tooth
ToothCondition
TreatmentPlan
TreatmentPlanItem
DentalProcedure
ClinicalDocument
DocumentTemplate
Exam
ClinicalImage
```

Os nomes finais deverão ser definidos de acordo com a arquitetura e convenções atuais do Kivo.

---

# 24. Regras importantes

### 24.1 Não duplicar funcionalidades

Antes de criar qualquer nova funcionalidade, verificar se o Kivo Core já possui algo equivalente.

### 24.2 Não confiar no frontend

Todas as permissões deverão ser verificadas no backend.

### 24.3 Histórico clínico

Não permitir exclusão silenciosa de registros clínicos.

### 24.4 Multiempresa

O módulo deverá respeitar o isolamento de dados existente no Kivo.

Um usuário de uma empresa não poderá acessar pacientes de outra empresa.

### 24.5 Profissionais

O profissional deverá possuir seus dados profissionais, incluindo CRO, quando aplicável.

### 24.6 Auditoria

Operações críticas devem possuir registro de auditoria.

### 24.7 Offline

Caso o Kivo Odonto utilize a arquitetura offline existente do Kivo, deverá ser definido posteriormente quais dados clínicos poderão ser utilizados offline e como será realizada a sincronização.

Não implementar sincronização específica antes de estudar a estratégia atual do Kivo.

---

# 25. LGPD e segurança

O módulo tratará dados pessoais e informações relacionadas à saúde.

Portanto, a implementação deverá considerar:

- Controle de acesso;
- Autenticação;
- Autorização;
- Auditoria;
- Isolamento por empresa;
- Proteção de arquivos;
- Controle de acesso aos documentos;
- Backup;
- Exclusão lógica quando aplicável;
- Segurança das APIs;
- Logs.

A arquitetura deverá ser preparada para atender aos requisitos aplicáveis de proteção de dados e sigilo profissional.

---

# 26. O que NÃO entra inicialmente

Para evitar transformar a primeira versão em um projeto excessivamente grande, não implementar inicialmente:

- Aplicativo próprio do paciente;
- Integração completa com WhatsApp;
- IA para diagnóstico;
- Prescrição eletrônica oficial;
- Integração com equipamentos odontológicos;
- Integração com convênios;
- Automação de estoque por procedimento;
- Teleodontologia;
- Marketplace;
- Multiunidade avançado;
- BI avançado.

Esses recursos deverão permanecer como roadmap.

---

# 27. Roadmap

## Fase 1 — Fundação

- Estrutura do módulo;
- Rotas;
- Permissões;
- Menu;
- Banco de dados;
- Integração com Core.

## Fase 2 — Pacientes

- Cadastro;
- Histórico;
- Anamnese.

## Fase 3 — Agenda

- Agenda;
- Agendamento;
- Status;
- Atendimento.

## Fase 4 — Prontuário

- Evolução;
- Histórico;
- Registros clínicos.

## Fase 5 — Odontograma

- Interface visual;
- Dentes;
- Superfícies;
- Condições;
- Histórico.

## Fase 6 — Tratamentos

- Procedimentos;
- Plano de tratamento;
- Aprovação;
- Integração financeira.

## Fase 7 — Documentos

- Templates;
- PDF;
- Documentos clínicos.

## Fase 8 — Exames e imagens

- Upload;
- Organização;
- Visualização;
- Vinculação ao paciente.

## Fase 9 — Refinamento

- Dashboard;
- Relatórios;
- Auditoria;
- UX;
- Segurança;
- Testes.

---

# 28. Critérios de conclusão da versão 1.0

O Kivo Odonto poderá ser considerado funcional quando um consultório conseguir executar o seguinte fluxo sem utilizar outro sistema:

```text
Cadastrar clínica
      ↓
Cadastrar dentista
      ↓
Cadastrar paciente
      ↓
Preencher anamnese
      ↓
Agendar consulta
      ↓
Realizar atendimento
      ↓
Registrar evolução
      ↓
Registrar odontograma
      ↓
Criar plano de tratamento
      ↓
Aprovar tratamento
      ↓
Gerar cobrança
      ↓
Registrar pagamento
      ↓
Gerar documento
      ↓
Consultar histórico do paciente
```

---

# 29. Diretriz de desenvolvimento

Antes de implementar qualquer tela:

1. Inspecionar a arquitetura atual do Kivo;
2. Identificar módulos reutilizáveis;
3. Identificar entidades existentes;
4. Identificar padrões de rotas;
5. Identificar padrões de controllers/services;
6. Identificar padrões de frontend;
7. Identificar sistema atual de permissões;
8. Identificar sistema financeiro;
9. Identificar sistema de usuários;
10. Identificar sistema de arquivos;
11. Identificar estratégia atual de sincronização;
12. Só então definir as novas entidades e telas.

**Não assumir a arquitetura atual sem verificar o código existente.**

---

# 30. Primeira tarefa do agente de desenvolvimento

A primeira etapa não é programar.

O agente deverá realizar uma **auditoria do Kivo atual** e produzir um documento:

`KIVO_ODONTO_ARCHITECTURE_AUDIT.md`

Esse documento deverá identificar:

- Stack;
- Estrutura de diretórios;
- Módulos existentes;
- Modelos;
- Controllers;
- Services;
- Routes;
- Views/componentes;
- Autenticação;
- Autorização;
- Banco de dados;
- Financeiro;
- Estoque;
- Agenda, caso exista;
- Uploads;
- Logs;
- Auditoria;
- Sincronização;
- APIs;
- Padrões de código.

Ao final da auditoria, o agente deverá apresentar:

### A. O que pode ser reutilizado

### B. O que precisa ser adaptado

### C. O que precisa ser criado

### D. Riscos técnicos

### E. Sugestão de ordem de implementação

Somente após essa auditoria deverá começar a implementação do Kivo Odonto.

---

# 31. Resultado esperado

Ao final do projeto, o Kivo deverá possuir um novo módulo:

> **Kivo Odonto — Gestão completa para consultórios e clínicas odontológicas.**

O módulo deverá utilizar a infraestrutura existente do Kivo sempre que possível, mantendo a filosofia modular da plataforma e evitando duplicação de funcionalidades.

A prioridade é construir uma base sólida, segura e extensível, permitindo que futuras versões adicionem recursos avançados sem necessidade de reescrever o módulo.