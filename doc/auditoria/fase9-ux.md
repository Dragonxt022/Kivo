# FASE 9 — UX

## Escopo

Análise de fluxo, telas, mensagens, feedback, atalhos e produtividade.

---

## Resultados

| Item | Avaliação | Gravidade |
|------|-----------|-----------|
| Fluxo de navegação | ✅ Hub-and-spoke, home como launcher | — |
| Telas | ✅ Consistentes (h1 + toolbar + tabela + pager) | — |
| Mensagens | ✅ Português claro, acentos corretos | — |
| Estados de loading | ⚠️ Só texto "Carregando...", sem spinners | Baixa |
| Estados vazios | ✅ empty-state.ejs partial reutilizado | — |
| Confirmações | ✅ confirm.ejs global com Promise | — |
| Atalhos (PDV) | ✅ F2/F4/F7/F9/F11 + setas | — |
| Atalhos (global) | ❌ Só Escape para drawer | Baixa |
| Breadcrumb | ❌ Ausente | Baixa |
| Alpine.js | ✅ Bem estruturado, componentizado | — |
| CSS | ✅ Custom properties, dark mode, responsivo | — |
| Responsividade | ⚠️ Desktop-first, mobile limitado | Baixa |
| Formulários | ✅ Autofocus, masks, validação inline | — |
| PDV componente | ⚠️ Monolítico (~1307 linhas) | Média |
| Nav múltiplas APIs | ⚠️ 4+ chamadas por página carregada | Média |
| password nativo alert() | ⚠️ Usa alert() em vez de dialog | Baixa |

---

## Nota da FASE 9: B

**Justificativa:** UX bem construída com Alpine.js e CSS moderno. Fluxo claro,
mensagens em português, feedback visual consistente. Melhorias possíveis:
loading spinners, breadcrumb, atalhos globais, e componentizar o PDV.
