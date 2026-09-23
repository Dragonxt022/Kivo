/**
 * KIVO IA — ponte entre o app local e os provedores de IA.
 *
 * O app local (offline-first, CSP `connect-src 'self'`) não fala com a IA direto: ele manda
 * a requisição para cá, com as credenciais de licença, e o cloud chama o provedor escolhido.
 * Quem configura provedores e chaves é o time do Kivo, no painel (Configurações › KIVO IA) —
 * o cliente nunca vê chave. O padrão é o Ollama da VPS.
 *
 * Antes de chamar o modelo, o cloud injeta os trechos mais relevantes da documentação técnica
 * e da wiki (`aiKnowledge`) no prompt de sistema, para a IA responder com o conteúdo oficial
 * do Kivo em vez de inventar.
 *
 * Autenticação: `requireCompanyAuth` (X-Kivo-Company / X-Kivo-License-Key), o mesmo par já
 * usado pelo sync. Rate limit por IP para uma empresa não consumir a GPU de todo mundo.
 */
import { Router } from 'express';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { createRateLimiter } from '../rateLimit';
import { currentPeriod, ensurePeriod, getCredits, recordUsage } from '../aiUsage';
import { buildKnowledgeContext, type KnowledgeLink } from '../aiKnowledge';
import { loadAiConfig } from '../aiConfig';
import {
  chat,
  defaultModelFor,
  isProviderId,
  keyFor,
  listProviders,
  type ChatMessage,
  type ProviderId,
} from '../aiProviders';

const router = Router();

const limit = createRateLimiter({ windowMs: 60_000, max: 40, keyPrefix: 'ai:' });

/**
 * Traduz o erro técnico do provedor para uma mensagem amigável, guardando o texto original em
 * `detail` — a tela mostra o amigável e oferece um "exibir erro" discreto para quem quiser o
 * detalhe (suporte). Nada de despejar JSON do Ollama na cara do lojista.
 */
function friendlyAiError(raw: string): { error: string; detail?: string } {
  const r = raw || '';
  if (/model .*not found|modelo.*n[ãa]o|not found|no such model/i.test(r)) {
    return { error: 'A IA ainda não está configurada. Avise o suporte para liberar o assistente.', detail: r };
  }
  if (/Nenhuma chave configurada|n[ãa]o est[áa] configurado/i.test(r)) {
    return { error: 'Este assistente de IA ainda não está liberado. Fale com o suporte.', detail: r };
  }
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ETIMEDOUT|timeout|indispon[íi]/i.test(r)) {
    return { error: 'Não foi possível falar com a IA agora. Tente novamente em instantes.', detail: r };
  }
  if (/respondeu 5\d\d|Bad Gateway|502|503|504/i.test(r)) {
    return { error: 'A IA está indisponível no momento. Tente novamente mais tarde.', detail: r };
  }
  return { error: 'Não foi possível consultar a IA agora. Tente novamente em instantes.', detail: r };
}

/**
 * Status do serviço: provedores disponíveis (com modelos), se o Ollama está no ar e quanto a
 * empresa já consumiu dos créditos. É a partir daqui que o app local monta o seletor de agente.
 */
router.get('/status', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const period = currentPeriod();
  await ensurePeriod(companyUuid, period);
  const credits = await getCredits(companyUuid);

  const cfg = await loadAiConfig();
  const all = await listProviders(cfg);
  const providers = all.filter((p) => p.configured);
  const ollama = all.find((p) => p.id === 'ollama');
  const online = (ollama?.models.length ?? 0) > 0;
  res.json({
    enabled: cfg.enabled,
    defaultProvider: cfg.defaultProvider,
    online,
    model: cfg.ollamaModel,
    models: ollama?.models ?? [],
    providers,
    credits,
    error: online ? undefined : 'Ollama indisponível ou sem modelos instalados.',
  });
});

/** Chat (não-streaming): recebe mensagens, injeta o contexto do Kivo e devolve a resposta. */
router.post('/chat', requireCompanyAuth, async (req: AuthedRequest, res) => {
  if (limit(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Muitas requisições de IA. Aguarde um instante.' });
    return;
  }

  const body = (req.body ?? {}) as {
    messages?: ChatMessage[];
    prompt?: string;
    system?: string;
    model?: string;
    temperature?: number;
    provider?: string;
    knowledge?: boolean;
    userName?: string;
  };

  const cfg = await loadAiConfig();
  if (!cfg.enabled) {
    res.status(400).json({ error: 'A KIVO IA está desativada no servidor. Fale com o suporte.' });
    return;
  }

  const provider: ProviderId = isProviderId(body.provider) ? body.provider : cfg.defaultProvider;
  if (provider !== 'ollama' && !keyFor(cfg, provider)) {
    res.status(400).json({ error: 'Este provedor de IA não está configurado no servidor.' });
    return;
  }
  // Só o Ollama (servidor da VPS) consome os créditos da empresa; os provedores externos são
  // pagos pela Kivo na chave do painel.
  const usesServerAi = provider === 'ollama';

  const companyUuid = req.companyUuid!;
  const period = currentPeriod();
  let credits = await getCredits(companyUuid);
  if (usesServerAi) {
    await ensurePeriod(companyUuid, period);
    credits = await getCredits(companyUuid);
    if (credits && credits.limit > 0 && credits.used >= credits.limit) {
      res.status(402).json({
        error: 'Créditos de IA esgotados neste período. Fale com o suporte para ampliar o limite.',
        code: 'ai_credits_exhausted',
        credits,
      });
      return;
    }
  }

  const messages: ChatMessage[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  } else if (typeof body.prompt === 'string' && body.prompt.trim()) {
    messages.push({ role: 'user', content: body.prompt.trim() });
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    res.status(400).json({ error: 'Envie ao menos uma mensagem do usuário (prompt ou messages[]).' });
    return;
  }

  // Base de conhecimento: só quando a tela não desliga explicitamente (testes usam `knowledge:false`).
  let sources: string[] = [];
  let links: KnowledgeLink[] = [];
  const systemParts: string[] = [];
  const userName = typeof body.userName === 'string' ? body.userName.trim().slice(0, 80) : '';
  if (userName) {
    systemParts.push(
      `Você está atendendo ${userName} pelo suporte do Kivo. Trate a pessoa pelo nome quando fizer sentido `
      + 'e mantenha o fio da conversa: lembre-se do que já foi dito e não peça de novo o que já foi informado.',
    );
  }
  if (typeof body.system === 'string' && body.system.trim()) systemParts.push(body.system.trim());
  if (body.knowledge !== false) {
    const kb = buildKnowledgeContext(lastUser.content);
    if (kb.context) {
      sources = kb.sources;
      links = kb.links;
      systemParts.push(
        'Use a documentação oficial do Kivo abaixo para responder. Se a resposta não estiver nela, '
        + 'diga que não encontrou e ofereça encaminhar para o atendimento humano. Cite o nome da seção '
        + `quando ajudar.\n\n${kb.context}`,
      );
    }
  }
  if (systemParts.length) messages.unshift({ role: 'system', content: systemParts.join('\n\n') });

  const model = (typeof body.model === 'string' && body.model.trim()) || defaultModelFor(cfg, provider);
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined;

  try {
    const result = await chat(cfg, { provider, model, messages, temperature });
    if (result.promptTokens > 0 || result.completionTokens > 0) {
      await recordUsage(companyUuid, period, result.model, result.promptTokens, result.completionTokens);
    }
    const used = credits ? credits.used + result.promptTokens + result.completionTokens : null;
    res.json({
      ok: true,
      provider,
      model: result.model,
      content: result.content,
      sources,
      links,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.promptTokens + result.completionTokens,
      },
      credits: credits ? { ...credits, used } : null,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    res.status(502).json(friendlyAiError(raw));
  }
});

export default router;
