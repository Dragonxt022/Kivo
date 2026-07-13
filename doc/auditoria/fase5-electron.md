# FASE 5 — Electron

## Escopo

Análise de BrowserWindow, preload, IPC, contexto, atualização,
crash recovery e gerenciamento de memória.

---

## Resultados

| Item | Avaliação | Gravidade |
|------|-----------|-----------|
| BrowserWindow — webPreferences | ✅ contextIsolation=true, nodeIntegration=false | — |
| sandbox | ⚠️ Não definido (default false) | Média |
| Preload | ✅ Mínimo (só version) | — |
| contextBridge | ✅ Correto | — |
| IPC | ✅ Não usado (arquitetura HTTP) | — |
| Atualização (electron-updater) | ✅ Configurado, autoDownload=true | Baixa |
| Atualização (checkAppUpdates) | ❌ Stub vazio (não implementado) | Alta |
| Crash recovery (boot) | ✅ reportFatalBootError() | — |
| Crash recovery (runtime) | ❌ Sem uncaughtException handler | Moderado |
| Multiplas instâncias | ❌ Sem requestSingleInstanceLock | Moderado |
| Gerenciamento de memória | ⚠️ win sem listener 'closed' | Baixa |
| file:// protocol | ✅ Não usado | — |
| shell.openExternal/dangerous | ✅ Não encontrado | — |
| asar | ⚠️ false (código solto na instalação) | Moderado |
| Assinatura digital | ❌ Sem certificado (SmartScreen warning) | Baixa |

---

## Nota da FASE 5: B

**Justificativa:** Camada Electron bem configurada (contextIsolation, nodeIntegration,
sem IPC, preload minimalista). Os gaps são: sandbox desligado, sem proteção contra
múltiplas instâncias, sem crash handler runtime, e `asar: false`.
