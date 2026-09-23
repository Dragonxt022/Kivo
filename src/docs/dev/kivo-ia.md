# KIVO IA — Regras de Negócio

Assistente de IA do Kivo. O app local **não** fala com a IA direto: ele manda a requisição
para o **Kivo Web**, que roteia para o **Ollama** que roda na VPS.

## Arquitetura

```
App local (navegador) → servidor local → Kivo Web (cloud) → Ollama (VPS)
```

- O navegador só fala com o próprio servidor local (CSP `connect-src 'self'`). Quem chama a
  nuvem é o **servidor local**, com as credenciais de licença.
- O cloud valida a licença (`requireCompanyAuth`) e encaminha para o Ollama local do servidor.
- Assim a IA fica centralizada na VPS: o lojista não configura rede nem instala nada.

## Configuração (Configurações › KIVO IA)

| Chave | Efeito |
| --- | --- |
| `ia.ativo` | Liga/desliga a KIVO IA (padrão desligada) |
| `ia.modelo` | Modelo do Ollama (ex.: `llama3.2`). Vazio = padrão do servidor |
| `ia.prompt` | Prompt de sistema (personalidade/instruções fixas) |
| `ia.temperatura` | 0 a 1 (padrão 0,7) |

A tela tem um botão **Testar IA** que envia uma pergunta de teste e mostra a resposta, um
indicador de status (online/offline) e o **consumo de créditos** da empresa.

### Descoberta de modelos

O campo de modelo é preenchido com os modelos que o Ollama tem instalado (a tela busca a
lista no cloud, que consulta `OLLAMA_URL/api/tags`). O lojista escolhe na lista ou digita —
nada de modelo fixo no código. Em branco, usa o `OLLAMA_MODEL` do servidor.

## Uso e créditos

- Cada requisição grava tokens de entrada/saída em `ai_usage` e soma no total da empresa.
- `companies.ai_token_limit` é o **teto mensal de tokens** (0 = ilimitado);
  `ai_tokens_used` + `ai_period` (AAAA-MM) zeram todo dia 1º.
- Ao esgotar, o cloud responde **402** com `code: ai_credits_exhausted` e a tela avisa.

## Painel de uso (Kivo Web › KIVO IA)

Em `/admin/ai` o painel mostra:

- KPIs do mês: tokens, requisições e empresas usando.
- **Gráfico de barras**: tokens por dia (últimos 14 dias).
- **Gráfico de pizza**: uso por empresa no mês.
- Tabela de **créditos por empresa**, com o teto editável (tokens/mês).

## Rotas

**Local** (app, autenticado, permissão `settings.view`):

- `GET /api/ai/status` — configuração + se o Ollama está no ar.
- `POST /api/ai/chat` — recebe `prompt` (ou `messages[]`) e devolve a resposta.

**Cloud** (`/api/ai`, credenciais de licença):

- `GET /api/ai/status` — consulta `OLLAMA_URL/api/tags` e lista os modelos.
- `POST /api/ai/chat` — encaminha para `OLLAMA_URL/api/chat` (não-streaming). Rate limit por
  IP (40/min).

## Configuração do servidor (cloud)

Variáveis de ambiente (ver `cloud/.env.example`):

| Variável | Padrão | Papel |
| --- | --- | --- |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Onde o Ollama escuta na VPS |
| `OLLAMA_MODEL` | `llama3.2` | Modelo padrão quando o app não escolhe |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout da resposta do modelo |

## Erros comuns

- "A KIVO IA está desligada." — ligue em Configurações › KIVO IA.
- "Kivo Web não configurado." — falta licença/URL do servidor.
- "Falha ao falar com o Ollama." — o serviço do Ollama está fora na VPS (checar `OLLAMA_URL`).
- "Muitas requisições de IA." — rate limit; aguardar um instante.

## Arquivos-chave

- `cloud/src/routes/ai.ts` — proxy para o Ollama (créditos + medição).
- `cloud/src/aiUsage.ts` — período, teto e registro de tokens.
- `cloud/migrations/0037_ai_usage` — colunas de créditos e tabela `ai_usage`.
- `cloud/src/routes/admin.ts` + `cloud/src/views/ai-usage.ejs` — painel de uso.
- `src/core/ai/service.ts` — configuração e chamada ao Kivo Web.
- `src/core/ai/routes.ts` — rotas locais.
- `src/views/settings.ejs` — aba KIVO IA.
