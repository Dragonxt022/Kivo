/**
 * KIVO IA — ponte entre o app local e o Ollama que roda na VPS.
 *
 * O app local (offline-first, CSP `connect-src 'self'`) não fala com o Ollama direto: ele
 * manda a requisição para cá, com as credenciais de licença, e o cloud encaminha para o
 * Ollama local do servidor (`OLLAMA_URL`). Assim a IA fica centralizada na VPS e o lojista
 * não precisa configurar nada de rede.
 *
 * Autenticação: `requireCompanyAuth` (X-Kivo-Company / X-Kivo-License-Key), o mesmo par já
 * usado pelo sync. Rate limit por IP para uma empresa não consumir a GPU de todo mundo.
 */
import { Router } from 'express';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { createRateLimiter } from '../rateLimit';
import { currentPeriod, ensurePeriod, getCredits, recordUsage } from '../aiUsage';

const router = Router();

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
/** Modelo padrão quando o app local não escolhe um. Configurável por `OLLAMA_MODEL`. */
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';
/** Timeout generoso: modelos maiores podem levar dezenas de segundos na primeira resposta. */
const CHAT_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);

const limit = createRateLimiter({ windowMs: 60_000, max: 40, keyPrefix: 'ai:' });

type ChatRole = 'system' | 'user' | 'assistant';
interface ChatMessage { role: ChatRole; content: string }

/**
 * Status do serviço: se o Ollama está no ar, QUAIS modelos estão disponíveis e quanto a
 * empresa já consumiu dos créditos. É a partir daqui que o app local monta a lista de
 * modelos — nada de fixar um modelo no código.
 */
router.get('/status', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const period = currentPeriod();
  await ensurePeriod(companyUuid, period);
  const credits = await getCredits(companyUuid);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      res.json({ online: false, model: DEFAULT_MODEL, credits, error: `Ollama respondeu ${r.status}.` });
      return;
    }
    const data = (await r.json()) as { models?: { name: string; size?: number; details?: { parameter_size?: string } }[] };
    const models = (data.models ?? []).map((m) => ({ name: m.name, size: m.size ?? null, parameterSize: m.details?.parameter_size ?? null }));
    res.json({ online: true, model: DEFAULT_MODEL, models, credits });
  } catch (e) {
    res.json({ online: false, model: DEFAULT_MODEL, credits, error: e instanceof Error ? e.message : 'Ollama indisponível.' });
  }
});

/** Chat simples (não-streaming): recebe mensagens, devolve a resposta do modelo. */
router.post('/chat', requireCompanyAuth, async (req: AuthedRequest, res) => {
  if (limit(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Muitas requisições de IA. Aguarde um instante.' });
    return;
  }

  // Créditos: zera no virar do mês e barra quando o teto da empresa foi atingido.
  const companyUuid = req.companyUuid!;
  const period = currentPeriod();
  await ensurePeriod(companyUuid, period);
  const credits = await getCredits(companyUuid);
  if (credits && credits.limit > 0 && credits.used >= credits.limit) {
    res.status(402).json({
      error: 'Créditos de IA esgotados neste período. Fale com o suporte para ampliar o limite.',
      code: 'ai_credits_exhausted',
      credits,
    });
    return;
  }

  const body = (req.body ?? {}) as {
    messages?: ChatMessage[]; prompt?: string; system?: string; model?: string; temperature?: number;
  };

  const messages: ChatMessage[] = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system.trim() });
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  } else if (typeof body.prompt === 'string' && body.prompt.trim()) {
    messages.push({ role: 'user', content: body.prompt.trim() });
  }
  if (!messages.some((m) => m.role === 'user')) {
    res.status(400).json({ error: 'Envie ao menos uma mensagem do usuário (prompt ou messages[]).' });
    return;
  }

  const model = (typeof body.model === 'string' && body.model.trim()) || DEFAULT_MODEL;
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined;

  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: temperature != null ? { temperature } : undefined,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: `Ollama respondeu ${r.status}. ${detail.slice(0, 200)}` });
      return;
    }
    const data = (await r.json()) as {
      message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number;
    };
    const promptTokens = Number(data.prompt_eval_count ?? 0);
    const completionTokens = Number(data.eval_count ?? 0);
    if (promptTokens > 0 || completionTokens > 0) {
      await recordUsage(companyUuid, period, data.model ?? model, promptTokens, completionTokens);
    }
    const used = credits ? credits.used + promptTokens + completionTokens : null;
    res.json({
      ok: true,
      model: data.model ?? model,
      content: data.message?.content ?? '',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      credits: credits ? { ...credits, used } : null,
    });
  } catch (e) {
    res.status(502).json({ error: `Falha ao falar com o Ollama (${OLLAMA_URL}): ${e instanceof Error ? e.message : String(e)}` });
  }
});

export default router;
