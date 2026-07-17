import { Router } from 'express';
import { getLicenseCredentials } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';

/**
 * Chat de suporte — proxy autenticado para a API de tickets do cloud.
 *
 * A UI (widget no home) fala com estas rotas locais; a credencial da licença
 * (company_uuid + license_key) nunca chega ao navegador — quem assina a chamada
 * ao cloud é o servidor local. O nome do usuário logado vai junto em cada
 * mensagem, então a conversa vira uma trilha de auditoria do atendimento.
 */
const router = Router();

function cloudBase(): string | null {
  const url = getCloudServerUrl();
  return url ? url.replace(/\/$/, '') : null;
}

function authHeaders(): Record<string, string> | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) return null;
  return {
    'Content-Type': 'application/json',
    'X-Katsu-Company': companyUuid,
    'X-Katsu-License-Key': licenseKey,
  };
}

/** Repassa a chamada ao cloud preservando status e corpo JSON. */
async function proxy(
  res: import('express').Response,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<void> {
  const base = cloudBase();
  const headers = authHeaders();
  if (!base || !headers) {
    res.status(503).json({ error: 'Chat de suporte indisponível: licença ou servidor de nuvem não configurados.' });
    return;
  }
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    res.status(503).json({ error: 'Sem conexão com o servidor de suporte — tente novamente quando estiver online.' });
    return;
  }
  const json = await upstream.json().catch(() => ({}));
  res.status(upstream.status).json(json as Record<string, unknown>);
}

router.get('/tickets', (_req, res) => {
  void proxy(res, '/api/support/tickets');
});

router.post('/tickets', (req, res) => {
  const { subject, category, message } = (req.body ?? {}) as Record<string, unknown>;
  void proxy(res, '/api/support/tickets', {
    method: 'POST',
    body: { subject, category, message, userName: req.user?.name },
  });
});

router.get('/tickets/:id/messages', (req, res) => {
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/messages`);
});

router.post('/tickets/:id/messages', (req, res) => {
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/messages`, {
    method: 'POST',
    body: { body: (req.body ?? {}).body, userName: req.user?.name },
  });
});

router.post('/tickets/:id/close', (req, res) => {
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/close`, { method: 'POST' });
});

/** Link da página de vendas, para o atalho "compartilhar com um amigo" do widget. */
router.get('/share-link', (_req, res) => {
  res.json({ url: cloudBase() ?? 'https://github.com/Dragonxt022/katsu/releases' });
});

export default router;
