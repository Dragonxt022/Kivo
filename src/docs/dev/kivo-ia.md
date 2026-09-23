# KIVO IA — Regras de Negócio

Assistente de IA do Kivo, usado principalmente como **chat de suporte**: responde dúvidas do
lojista com base na documentação técnica e na wiki, e cada conversa vira um chamado no Kivo
Web para o suporte humano acompanhar depois.

## Arquitetura

```
App local (navegador) → servidor local → Kivo Web (cloud) → provedor de IA
                                                             ├── Ollama (VPS)
                                                             ├── OpenAI (ChatGPT)
                                                             ├── DeepSeek
                                                             └── Anthropic (Claude)
```

- O navegador só fala com o próprio servidor local (CSP `connect-src 'self'`). Quem chama a
  nuvem é o **servidor local**, com as credenciais de licença.
- O cloud valida a licença (`requireCompanyAuth`), injeta o conhecimento do Kivo e chama o
  provedor configurado.
- **Quem configura provedores e chaves é o time do Kivo**, no painel do Cloud
  (Configurações › KIVO IA). O cliente não vê chave nenhuma — é a Kivo que revende o serviço.

## Provedores (seletor de agente)

| Provedor | Chave | Observação |
| --- | --- | --- |
| `ollama` | Não | Padrão. Roda na VPS; consome os créditos da empresa |
| `openai` | Sim | ChatGPT (`gpt-4o-mini`, `gpt-4o`, …) |
| `deepseek` | Sim | `deepseek-chat`, `deepseek-reasoner` |
| `anthropic` | Sim | Claude (`claude-3-5-*`, …) |

A lista de modelos do Ollama vem de `OLLAMA_URL/api/tags`; nos demais, a lista é sugerida e o
campo aceita texto livre. Só entram no seletor os provedores com chave configurada. O seletor
aparece no chat de suporte (widget de ajuda) do app.

## Base de conhecimento (RAG)

O cloud indexa duas fontes que já existem no produto:

- `src/docs/dev/*.md` — documentação técnica (a mesma de `/admin/documentacao`);
- `cloud/src/views/wiki.ejs` — wiki pública (passo a passo ilustrado).

O índice é montado em memória (`cloud/src/aiKnowledge.ts`): cada seção vira um trecho, e a
pergunta do usuário recupera os trechos mais relevantes por **BM25 simplificado** (sem banco
vetorial nem dependência nova). O trecho entra no prompt de sistema, com instrução para a IA
não inventar: se não estiver na documentação, ela avisa e oferece o atendimento humano. As
fontes usadas voltam em `sources`.

## Configuração no painel (Kivo Cloud › Configurações › KIVO IA)

| Chave em `app_settings` | Efeito |
| --- | --- |
| `ai_enabled` | Liga/desliga a KIVO IA no servidor |
| `ai_default_provider` | Provedor padrão: `ollama`, `openai`, `deepseek` ou `anthropic` |
| `ai_ollama_url` | URL do Ollama (padrão `OLLAMA_URL` ou `http://127.0.0.1:11434`) |
| `ai_ollama_model` | Modelo padrão do Ollama (padrão `llama3.2`) |
| `ai_openai_key` | Chave OpenAI (opcional) |
| `ai_deepseek_key` | Chave DeepSeek (opcional) |
| `ai_anthropic_key` | Chave Anthropic (opcional) |

As chaves ficam no servidor e **nunca voltam para a tela** (só um sinalizador de "já
configurada"). Há um botão **Testar IA** no painel.

No app, o lojista só ajusta preferências em Configurações › KIVO IA: `ia.ativo`, `ia.modelo`
(vazio = padrão do servidor), `ia.prompt` (instruções) e `ia.temperatura`.

## Chat de suporte

O widget de ajuda (tela inicial) tem a opção **Falar com a Kivo IA**. Ao enviar a primeira
mensagem:

1. O desktop **abre um chamado automaticamente** no Kivo Web (assunto `Kivo IA — <pergunta>`),
   com a pergunta do usuário como primeira mensagem.
2. A pergunta vai para o KIVO IA, que responde com o conhecimento do Kivo.
3. A resposta é gravada **no mesmo chamado**, com `sender = 'ia'` (a conversa inteira fica na
   trilha do atendimento; o suporte vê e assume quando precisar).

Mensagens da IA não contam como não-lido do admin (o chamado já nasce não-lido). O painel
`/admin/support` mostra a IA com um balão próprio.

## Uso e créditos

- Cada requisição grava tokens de entrada/saída em `ai_usage` e soma no total da empresa.
- `companies.ai_token_limit` é o **teto mensal de tokens** (0 = ilimitado);
  `ai_tokens_used` + `ai_period` (AAAA-MM) zeram todo dia 1º.
- Ao esgotar, o cloud responde **402** com `code: ai_credits_exhausted` e a tela avisa.
- O teto só vale para o **Ollama** (IA da VPS). Provedores externos são pagos pela Kivo na
  chave do painel e não passam pelo teto — o uso continua registrado.

## Painel de uso (Kivo Web › KIVO IA)

Em `/admin/ai` o painel mostra KPIs do mês, tokens por dia (14 dias), uso por empresa e a
tabela de créditos com o teto editável (tokens/mês).

## Rotas

**Local** (app, autenticado):

- `GET /api/ai/status` — configuração local, provedores/modelos disponíveis e créditos.
- `POST /api/ai/chat` — recebe `prompt` (ou `messages[]`) e `provider`/`model`; devolve a resposta.

**Cloud** (`/api/ai`, credenciais de licença):

- `GET /api/ai/status` — lista provedores configurados/modelos (Ollama via `/api/tags`) e créditos.
- `POST /api/ai/chat` — injeta o conhecimento e chama o provedor (não-streaming). Rate limit por
  IP (40/min).

**Painel admin** (sessão de admin): `GET/POST /admin/settings` (bloco KIVO IA) e
`POST /admin/settings/ai/test`.

## Variáveis de ambiente (cloud)

Reserva para deploy sem tocar no painel (ver `cloud/.env.example`):

| Variável | Padrão | Papel |
| --- | --- | --- |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Onde o Ollama escuta na VPS |
| `OLLAMA_MODEL` | `llama3.2` | Modelo padrão do Ollama |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout da resposta do modelo |
| `OPENAI_API_KEY` | — | Chave OpenAI (opcional) |
| `DEEPSEEK_API_KEY` | — | Chave DeepSeek (opcional) |
| `ANTHROPIC_API_KEY` | — | Chave Anthropic (opcional) |

Os `*_BASE_URL` permitem apontar para proxies/gateways compatíveis.

## Erros comuns

- "A KIVO IA está desligada." — ligue em Configurações › KIVO IA (app).
- "A KIVO IA está desativada no servidor." — o admin precisa ligar no painel Cloud.
- "Este provedor de IA não está configurado no servidor." — falta chave no painel.
- "Kivo Web não configurado." — falta licença/URL do servidor.
- "Falha ao falar com o Ollama." — o serviço do Ollama está fora na VPS (checar `OLLAMA_URL`).
- "Muitas requisições de IA." — rate limit; aguardar um instante.

## Arquivos-chave

- `cloud/src/aiProviders.ts` — provedores (Ollama/OpenAI/DeepSeek/Anthropic).
- `cloud/src/aiConfig.ts` — configuração (provedor padrão e chaves) em `app_settings`.
- `cloud/src/aiKnowledge.ts` — índice da documentação + wiki e busca por trechos.
- `cloud/src/routes/ai.ts` — status/chat com injeção de conhecimento e créditos.
- `cloud/src/aiUsage.ts` — período, teto e registro de tokens.
- `cloud/src/routes/admin.ts` + `cloud/src/views/admin-settings.ejs` — bloco KIVO IA do painel.
- `cloud/src/routes/support.ts` — tickets, incluindo mensagens com `sender = 'ia'`.
- `cloud/src/views/ai-usage.ejs` — painel de uso.
- `src/core/ai/service.ts` — preferências locais e chamada ao Kivo Web.
- `src/core/ai/routes.ts` — rotas locais (status, chat).
- `src/views/settings.ejs` — aba KIVO IA (preferências do lojista).
- `src/views/home.ejs` — widget de suporte com o chat da KIVO IA.
