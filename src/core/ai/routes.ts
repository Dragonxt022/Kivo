import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { aiStatus, aiChat, aiConfig, type AiChatMessage } from './service';

/** Rotas da KIVO IA (tela de configuração e teste). Montadas em /api/ai, já autenticadas. */
const router = Router();

/** Configuração atual + status do Ollama (via Kivo Web), para a tela de Configurações. */
router.get('/status', requirePermission('settings.view'), async (_req, res) => {
  const config = aiConfig();
  // Consulta sempre (mesmo com a IA desligada): é daqui que a tela pega a lista de modelos
  // disponíveis e o consumo de créditos da empresa.
  const status = await aiStatus();
  res.json({ config, ...status });
});

/** Chat/teste: recebe `prompt` (ou `messages[]`) e devolve a resposta da IA. */
router.post('/chat', requirePermission('settings.view'), async (req, res) => {
  const body = (req.body ?? {}) as { prompt?: string; messages?: AiChatMessage[] };
  const messages: AiChatMessage[] = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : (typeof body.prompt === 'string' && body.prompt.trim() ? [{ role: 'user', content: body.prompt.trim() }] : []);
  const result = await aiChat(messages);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
