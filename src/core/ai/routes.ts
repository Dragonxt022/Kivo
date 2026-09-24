import { Router } from 'express';
import { aiStatus, aiChat, type AiChatMessage } from './service';

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

export default router;
