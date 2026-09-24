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
import { clientTimezone } from '../tz';
import { listTools, loadTool, quotaStatus, refund, reserve } from '../aiQuota';
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
    res.status(400).json({ error: 'O assistente está indisponível no momento. Fale com um atendente.' });
    return;
  }

  const provider: ProviderId = isProviderId(body.provider) ? body.provider : cfg.defaultProvider;
  if (provider !== 'ollama' && !keyFor(cfg, provider)) {
    res.status(400).json({ error: 'Este provedor de IA não está configurado no servidor.' });
    return;
  }

  // O assistente de SUPORTE é sempre gratuito e ilimitado — não consome créditos nem depende de
  // ativação. Ferramentas de IA que vierem a cobrar créditos usarão outro caminho.
  const companyUuid = req.companyUuid!;
  const period = currentPeriod();
  await ensurePeriod(companyUuid, period);
  const credits = await getCredits(companyUuid);

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

// ─── Ferramentas de IA que COBRAM créditos (por uso, cota diária) ──────────────────────

/** Fuso do cliente: cabeçalho do desktop ou cookie do navegador (fallback Porto Velho). */
function reqTimezone(req: AuthedRequest): string {
  const h = String((req.headers['x-kivo-tz'] as string) ?? '').trim();
  return h || clientTimezone(req);
}

/** Lista as ferramentas e a situação da cota do dia para a empresa (para a tela do app). */
router.get('/tools', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const tz = reqTimezone(req);
  const tools = await listTools();
  const withStatus = [];
  for (const t of tools) {
    const status = await quotaStatus(companyUuid, t.id, tz);
    withStatus.push({ ...t, status });
  }
  res.json({ tools: withStatus });
});

/** Gera a descrição de um produto. Cobra 1 uso da cota diária (devolvido se a IA falhar). */
router.post('/tools/product-description', requireCompanyAuth, async (req: AuthedRequest, res) => {
  if (limit(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Muitas requisições de IA. Aguarde um instante.' });
    return;
  }
  const companyUuid = req.companyUuid!;
  const tz = reqTimezone(req);
  const b = (req.body ?? {}) as { name?: string; category?: string; keywords?: string };
  const name = String(b.name ?? '').trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: 'Informe o nome do produto.' });
    return;
  }

  const cfg = await loadAiConfig();
  const r = await reserve(companyUuid, 'product_description', tz);
  if (!r.ok) {
    const label = r.tool?.label ?? 'Descrição de produto';
    res.status(402).json({
      error: `Seus créditos de "${label}" acabaram hoje. Eles renovam à meia-noite.`,
      code: 'ai_quota_exhausted',
      status: r.status,
    });
    return;
  }

  const category = String(b.category ?? '').trim().slice(0, 120);
  const keywords = String(b.keywords ?? '').trim().slice(0, 200);
  const prompt =
    `Gere uma descrição curta e atraente para o produto "${name}"` +
    (category ? ` da categoria "${category}"` : '') +
    (keywords ? ` (palavras-chave: ${keywords})` : '') +
    '.\nRegras: português do Brasil; no máximo 2 frases; sem aspas; sem emojis; ' +
    'pode incluir os principais ingredientes/benefícios. Responda APENAS com a descrição.';

  try {
    const model = defaultModelFor(cfg, cfg.defaultProvider);
    const result = await chat(cfg, {
      provider: cfg.defaultProvider,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });
    await recordUsage(
      companyUuid,
      currentPeriod(),
      result.model,
      result.promptTokens,
      result.completionTokens,
      'product_description',
      r.status.cost,
    );
    const after = await quotaStatus(companyUuid, 'product_description', tz);
    res.json({
      ok: true,
      description: result.content.trim(),
      usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
      status: after,
    });
  } catch (e) {
    await refund(companyUuid, 'product_description', tz);
    const raw = e instanceof Error ? e.message : String(e);
    res.status(502).json(friendlyAiError(raw));
  }
});

// ─── Insights de vendas (ferramenta paga) ───────────────────────────────────────────────

const brl = (cents: number): string =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface SalesInsightsBody {
  from?: string;
  to?: string;
  salesCount?: number;
  totalCents?: number;
  ticketCents?: number;
  topProducts?: { name?: unknown; qty?: unknown; totalCents?: unknown }[];
  byPayment?: { method?: unknown; totalCents?: unknown }[];
  daily?: { day?: unknown; totalCents?: unknown }[];
  previous?: { totalCents?: unknown; salesCount?: unknown };
}

/** Monta o resumo textual das vendas que vai no prompt (limitado, para não estourar o contexto). */
function salesInsightsPrompt(b: SalesInsightsBody): { period: string; summary: string } {
  const from = String(b.from ?? '').slice(0, 10);
  const to = String(b.to ?? '').slice(0, 10);
  const salesCount = Math.max(0, Math.floor(Number(b.salesCount) || 0));
  const totalCents = Math.max(0, Math.floor(Number(b.totalCents) || 0));
  const ticketCents = Math.max(0, Math.floor(Number(b.ticketCents) || (salesCount ? Math.round(totalCents / salesCount) : 0)));

  const lines: string[] = [
    `Período: ${from} a ${to}`,
    `Vendas: ${salesCount}`,
    `Faturamento: ${brl(totalCents)}`,
    `Ticket médio: ${brl(ticketCents)}`,
  ];

  const prevTotal = Math.max(0, Math.floor(Number(b.previous?.totalCents) || 0));
  if (prevTotal > 0) {
    const delta = Math.round(((totalCents - prevTotal) / prevTotal) * 100);
    lines.push(`Período anterior: ${brl(prevTotal)} (variação ${delta >= 0 ? '+' : ''}${delta}%)`);
  }

  const products = Array.isArray(b.topProducts) ? b.topProducts.slice(0, 15) : [];
  if (products.length) {
    lines.push('', 'Produtos mais vendidos:');
    products.forEach((p, i) => {
      const name = String(p?.name ?? '').slice(0, 80) || 'Item';
      const qty = String(Number(p?.qty) || 0).replace('.', ',');
      const tot = Math.max(0, Math.floor(Number(p?.totalCents) || 0));
      lines.push(`${i + 1}. ${name} — ${qty} un — ${brl(tot)}`);
    });
  }

  const payments = Array.isArray(b.byPayment) ? b.byPayment.slice(0, 10) : [];
  if (payments.length) {
    lines.push('', 'Formas de pagamento:');
    for (const p of payments) {
      const method = String(p?.method ?? '').slice(0, 40) || 'Outros';
      const tot = Math.max(0, Math.floor(Number(p?.totalCents) || 0));
      lines.push(`- ${method}: ${brl(tot)}`);
    }
  }

  const daily = Array.isArray(b.daily) ? b.daily.slice(0, 62) : [];
  if (daily.length) {
    lines.push('', 'Faturamento por dia:');
    for (const d of daily) {
      const day = String(d?.day ?? '').slice(0, 10);
      if (day) lines.push(`${day}: ${brl(Math.max(0, Math.floor(Number(d?.totalCents) || 0)))}`);
    }
  }

  return { period: `${from} a ${to}`, summary: lines.join('\n') };
}

/** Gera insights das vendas do período. Cobra 1 uso da cota diária (devolvido se a IA falhar). */
router.post('/tools/sales-insights', requireCompanyAuth, async (req: AuthedRequest, res) => {
  if (limit(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Muitas requisições de IA. Aguarde um instante.' });
    return;
  }
  const companyUuid = req.companyUuid!;
  const tz = reqTimezone(req);
  const body = (req.body ?? {}) as SalesInsightsBody;

  // Sem vendas no período não há o que analisar — não gasta crédito.
  if (Math.max(0, Math.floor(Number(body.salesCount) || 0)) === 0) {
    const status = await quotaStatus(companyUuid, 'sales_insights', tz);
    res.json({ ok: true, insight: 'Não há vendas no período selecionado para analisar. Faça vendas ou escolha outro período.', status });
    return;
  }

  const cfg = await loadAiConfig();
  const r = await reserve(companyUuid, 'sales_insights', tz);
  if (!r.ok) {
    const label = r.tool?.label ?? 'Insights de vendas';
    res.status(402).json({
      error: `Seus créditos de "${label}" acabaram hoje. Eles renovam à meia-noite.`,
      code: 'ai_quota_exhausted',
      status: r.status,
    });
    return;
  }

  const { period, summary } = salesInsightsPrompt(body);
  const prompt =
    `Você é um analista de negócios de um comércio/restaurante. Analise os dados de venda do período ${period} abaixo `
    + 'e responda em português do Brasil, em tópicos curtos e acionáveis (no máximo ~8 linhas). '
    + 'Destaque o que está indo bem, o que merece atenção e 2 a 3 sugestões práticas. '
    + `Use APENAS os números fornecidos; não invente dados.\n\n${summary}`;

  try {
    const model = defaultModelFor(cfg, cfg.defaultProvider);
    const result = await chat(cfg, {
      provider: cfg.defaultProvider,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });
    await recordUsage(
      companyUuid,
      currentPeriod(),
      result.model,
      result.promptTokens,
      result.completionTokens,
      'sales_insights',
      r.status.cost,
    );
    const after = await quotaStatus(companyUuid, 'sales_insights', tz);
    res.json({ ok: true, insight: result.content.trim(), status: after });
  } catch (e) {
    await refund(companyUuid, 'sales_insights', tz);
    const raw = e instanceof Error ? e.message : String(e);
    res.status(502).json(friendlyAiError(raw));
  }
});

export default router;
