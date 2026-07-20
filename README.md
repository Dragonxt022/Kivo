# Kivo

Plataforma comercial modular desktop-first — PDV, estoque, financeiro, DRE.

**Stack:** Electron + Express 5 + TypeScript + better-sqlite3 + EJS + Alpine.js

---

## Quick start

```sh
npm install
npm run build
npm run kivo db:migrate
npm run kivo db:seed:demo
npm run dev
```

Acessar `http://localhost:3123`. Login padrão do seed: `admin` / `admin`.

### Sem seed

```sh
npm run dev
```

O primeiro acesso abre a tela de ativação.

### Ambiente desktop completo

```sh
npm run dev:electron
```

---

## Scripts principais

```sh
npm run kivo              # listar todos os comandos
npm run dev                # servidor Express
npm run build              # compilar TypeScript
npm run test               # rodar todos os testes
npm run lint               # ESLint
npm run format             # Prettier
```

A lista completa de comandos está em `scripts/commands.json`. Execute `npm run kivo` para vê-los todos.

---

## Arquitetura

```
src/
├── core/            # Framework: database, auth, modules, sync, license, services
├── modules/         # Módulos de domínio
│   ├── commercial/  # Produtos, clientes, estoque, pricing
│   ├── store/       # PDV: vendas, orçamentos
│   ├── finance/     # Caixa, contas a pagar/receber
│   ├── foodservice/ # Cozinha
│   └── comandas/    # Mesas
├── shared/          # Utilitários puros (money, date, cpf/cnpj…)
├── electron/        # bootstrap, main, preload
├── views/           # Templates EJS core
└── tests/           # Testes de integração (32 arquivos)
```

Cada módulo segue **Controller → Service → Repository**. Módulos comunicam-se exclusivamente via `getService()` — nunca por import direto.

---

## Licença

**All Rights Reserved.** Este software é proprietário. Não é permitido copiar, modificar, distribuir ou sublicenciar sem autorização expressa do autor.

© Kivo — Bruno Da Silva Pissinatti

---

## Contribuição

Este projeto é privado e não aceita contribuições externas no momento.

Se você encontrou um bug ou tem uma sugestão, abra uma issue no repositório oficial.

---

## Documentação

- `doc/KIVO_PLANO.md` — plano de desenvolvimento e arquitetura detalhada
- `doc/auditoria/` — relatórios de auditoria técnica (fases F1–F12)
- `agente.md` — perfil de programação do autor (contexto para assistentes de IA)
