import { Router } from 'express';
import { aiStatus, aiChat, aiTools, aiProductDescription, aiSalesInsights, type AiChatMessage } from './service';
import { buildSalesInsightsInput } from './salesSummary';
import { listCapabilities } from '../capabilities/service';

/** Rotas da KIVO IA (status e chat de suporte). Montadas em /api/ai. */
const router = Router();

/**
 * Status do assistente + consumo da empresa (via Kivo Web). O suporte está sempre disponível;
 * isto serve para a tela mostrar se a IA está no ar e quanto já foi usado.
 *
 * Sem `settings.view`: o chat de suporte é aberto por qualquer usuário.
 */
router.get('/status', async (_req, res) => {
  const status = await aiStatus();
  res.json(status);
});

/** Recursos (capabilities) da empresa + se o usuário pode ativá-los — o chat oferece ativar. */
router.get('/capabilities', (req, res) => {
  const canEdit = !!req.user?.permissions.has('settings.capabilities.edit');
  const capabilities = listCapabilities().map((c) => ({
    key: c.key,
    description: c.description,
    module: c.module,
    enabled: c.enabled === 1,
    beta: c.beta === 1,
  }));
  res.json({ canEdit, capabilities });
});

/** Chat de suporte: recebe `prompt` (ou `messages[]`) e devolve a resposta da IA. */
router.post('/chat', async (req, res) => {
  const body = (req.body ?? {}) as {
    prompt?: string;
    messages?: AiChatMessage[];
  };
  const messages: AiChatMessage[] = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : (typeof body.prompt === 'string' && body.prompt.trim() ? [{ role: 'user', content: body.prompt.trim() }] : []);
  const result = await aiChat(messages, { userName: req.user?.name });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

/** Ferramentas pagas + cota do dia (para Configurações › KIVO IA). */
router.get('/tools', async (_req, res) => {
  res.json(await aiTools());
});

/** Ferramenta paga: gera a descrição de um produto (consome crédito da cota diária). */
router.post('/product-description', async (req, res) => {
  const b = (req.body ?? {}) as { name?: string; category?: string; keywords?: string };
  const name = String(b.name ?? '').trim();
  if (!name) {
    res.status(400).json({ ok: false, error: 'Informe o nome do produto.' });
    return;
  }
  const result = await aiProductDescription({ name, category: b.category, keywords: b.keywords });
  if (!result.ok) {
    res.status(result.code === 'ai_quota_exhausted' ? 402 : 400).json(result);
    return;
  }
  res.json(result);
});

/** Ferramenta paga: insights das vendas do período (consome crédito da cota diária). */
router.post('/sales-insights', async (req, res) => {
  const b = (req.body ?? {}) as { from?: string; to?: string };
  const result = await aiSalesInsights(buildSalesInsightsInput(b.from, b.to));
  if (!result.ok) {
    res.status(result.code === 'ai_quota_exhausted' ? 402 : 400).json(result);
    return;
  }
  res.json(result);
});

export default router;
