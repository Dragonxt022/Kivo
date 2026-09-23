import { Router } from 'express';
import { aiStatus, aiChat, aiConfig, type AiChatMessage } from './service';

/** Rotas da KIVO IA (tela de configuração, chat de suporte e teste). Montadas em /api/ai. */
const router = Router();

/**
 * Configuração local + provedores disponíveis (via Kivo Web), para o seletor de agente.
 *
 * Sem `settings.view`: o chat de suporte é aberto por qualquer usuário (como o suporte), e a
 * tela usa isto só para montar a lista de provedores. A configuração em si (prompt, modelo)
 * só é editada em Configurações, que tem a permissão própria.
 *
 * Os provedores vêm do Cloud, que é quem configura e paga as chaves. Sem resposta (cloud
 * antigo/offline), cai no Ollama para a tela não ficar sem opção.
 */
router.get('/status', async (_req, res) => {
  const config = aiConfig();
  const status = await aiStatus();
  const providers = Array.isArray(status.providers) && status.providers.length
    ? status.providers
    : [{ id: 'ollama', label: 'Ollama (servidor Kivo)', configured: true, models: status.models ?? [] }];
  res.json({ config, ...status, providers });
});

/** Chat/teste: recebe `prompt` (ou `messages[]`) e devolve a resposta da IA. */
router.post('/chat', async (req, res) => {
  const body = (req.body ?? {}) as {
    prompt?: string;
    messages?: AiChatMessage[];
    provider?: string;
    model?: string;
  };
  const messages: AiChatMessage[] = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : (typeof body.prompt === 'string' && body.prompt.trim() ? [{ role: 'user', content: body.prompt.trim() }] : []);
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : null;
  const result = await aiChat(messages, { provider, model: body.model });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

export default router;
