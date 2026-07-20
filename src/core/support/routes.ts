import { Router } from 'express';
import { getLicenseCredentials } from '../license/service';
import { getCloudServerUrl, PRODUCTION_CLOUD_URL } from '../config/cloud';

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
    'X-Kivo-Company': companyUuid,
    'X-Kivo-License-Key': licenseKey,
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
  const { subject, category, message, attachment } = (req.body ?? {}) as Record<string, unknown>;
  void proxy(res, '/api/support/tickets', {
    method: 'POST',
    body: { subject, category, message, attachment, userName: req.user?.name },
  });
});

router.get('/tickets/:id/messages', (req, res) => {
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/messages`);
});

router.post('/tickets/:id/messages', (req, res) => {
  const { body, attachment } = (req.body ?? {}) as Record<string, unknown>;
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/messages`, {
    method: 'POST',
    body: { body, attachment, userName: req.user?.name },
  });
});

router.post('/tickets/:id/close', (req, res) => {
  void proxy(res, `/api/support/tickets/${Number(req.params.id)}/close`, { method: 'POST' });
});

/** Link da página de vendas, para o atalho "compartilhar com um amigo" do widget.
 * Sempre o domínio público oficial — nunca `cloudBase()`, que pode apontar para um
 * servidor de sync local/privado configurado pelo admin (sem sentido para indicar
 * a um amigo, e no caso de um endereço LAN nem seria alcançável por ele). */
router.get('/share-link', (_req, res) => {
  res.json({ url: PRODUCTION_CLOUD_URL });
});

export default router;
