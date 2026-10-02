# Perfis por segmento — o que ligar em cada ramo

Referência para **provisionar uma empresa** (painel do cloud → empresa → Módulos) e para
apoiar o cliente na primeira configuração. O assistente de boas-vindas recomenda os
**recursos finos** (capabilities) a partir do ramo declarado; os **módulos** são decisão do
plano, no painel, e o atalho "Perfil do segmento" já pré-marca os do ramo.

Regras de bolso que valem para todos os ramos:

- **Comercial** é a base (cliente, produto, estoque) — praticamente todo perfil pede.
- **Financeiro** sempre que existe dinheiro a receber/pagar; é ele que recebe a cobrança.
- **Fiscal** só onde se emite NFC-e de **mercadoria**. Serviço (clínica, salão, assistência)
  fica sem: NFS-e não existe no sistema.
- **NF-e** onde se compra de distribuidora com XML (a entrada já vem com lote/validade).
- **Etiquetas** onde existe gôndola/prateleira.
- **Comandas & Mesas** e **Food Service** só em comida servida em mesa.
- Nenhum módulo ligado = **sem restrição** (todos liberados). Cuidado: não é "liberar um só".

| Segmento | Módulos | Recursos recomendados | Cargos de fábrica que servem |
| --- | --- | --- | --- |
| **Odontologia / clínica** | comercial, finance, store, **odonto**, dre, nfe | nenhum de varejo (kits opcional) | Administrador, **Dentista**, **Recepção**, **Auxiliar** |
| **Farmácia** | comercial, finance, store, fiscal, nfe, dre, labels | kits (higiene), complementos | Administrador, Gerente, Caixa, Estoquista |
| **Roupas / calçados** | comercial, finance, store, fiscal, dre, labels | **variantes** (grade tamanho/cor) | Administrador, Vendedor, Caixa |
| **Sorveteria / açaí** | comercial, finance, store, dre, labels | **complementos** (toppings), **kits** (combo) | Administrador, Caixa, Vendedor |
| **Restaurante / lanchonete** | comercial, finance, store, comandas, foodservice, fiscal, dre, labels | comandas, cozinha (KDS), complementos, kits | Administrador, Garçom, Cozinha, Caixa |
| **Padaria / confeitaria** | comercial, finance, store, fiscal, nfe, dre, labels | **produção** (ficha técnica), kits, complementos | Administrador, Gerente, Caixa |
| **Mercado / mercearia** | comercial, finance, store, fiscal, nfe, dre, labels | kits (cesta), complementos | Administrador, Estoquista, Caixa |
| **Conveniência / adega** | comercial, finance, store, fiscal, nfe, dre, labels | kits (combo de bebidas) | Administrador, Caixa |
| **Petshop** | comercial, finance, store, nfe, dre, labels | — | Administrador, Vendedor, Caixa |
| **Serviços (salão, assistência)** | comercial, finance, store, dre | — | Administrador, Vendedor (ou cargo próprio) |

## Onde cada decisão vive

| Decisão | Onde | Efeito |
| --- | --- | --- |
| Módulos do plano | Painel do cloud → empresa → **Módulos** (ou `companies.modules` no MySQL) | Decide **acesso**: fora do plano a API responde 403 e a página redireciona |
| Recursos finos | App → Configurações › **Recursos** (ou assistente de boas-vindas) | Nascem desligados; desligado, o item some do menu e a API responde 403 |
| Cargos e permissões | App → **Cargos** | Um cargo novo nasce com o modelo de fábrica (`src/core/roles/presets.ts`) |
| Ramo declarado | Assistente de boas-vindas → `companies.business_type` | Pré-seleciona o perfil no painel e sugere os recursos no assistente |

**Ordem que evita retrabalho:** módulos → recursos → cargos → usuários → cadastros base.

## Catálogo de demonstração por ramo

Quem aceita "criar dados de exemplo" no assistente recebe um catálogo do próprio ramo
(`src/core/onboarding/demoCatalog.ts`): a clínica ganha procedimentos (tipo `servico`) e
material com estoque; a sorveteria, sabores, açaí com complementos e combo; a farmácia,
medicamentos e higiene — entre outros. `outro` nasce vazio de propósito.

## Arquivos-chave

- `src/core/onboarding/service.ts` — `WIZARD_FEATURES` (recomendação por ramo) e os ramos.
- `src/core/onboarding/demoCatalog.ts` — catálogo de exemplo por ramo.
- `src/public/js/onboarding.js` — cartões de ramo, ícone e cor sugerida.
- `src/core/roles/presets.ts` — cargos de fábrica.
- `cloud/src/views/partials/module-toggles.ejs` — atalho de perfil no painel.
