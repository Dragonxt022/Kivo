import { Router, type Request, type Response } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

/**
 * Fornece as credenciais da sede do Mais Delivery para a instalação local do cliente.
 * Autenticado por licença da empresa (X-Kivo-Company / X-Kivo-License-Key).
 * O cliente usa estas credenciais e preenche apenas o código de integração localmente.
 *
 * Este router MORA em `/api/maisdelivery` (montado no server.ts). Não mocks ele para
 * `admin.ts`: lá o router é montado sob `/admin`, e a rota viraria
 * `/admin/api/maisdelivery/credentials` — mas o Kivo chama `/api/maisdelivery/credentials`.
 */
const router = Router();

router.get(
  '/credentials',
  requireCompanyAuth,
  async (req: AuthedRequest, res: Response): Promise<void> => {
    void req;
    const [rows] = await getPool().query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('md_basic_auth','md_access_token_producao','md_access_token_sandbox','md_id_empresa_integrada','md_sandbox')",
    );
    const cfg = Object.fromEntries(
      (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [
        r.setting_key,
        r.setting_value,
      ]),
    );
    res.json({
      hasBasicAuth: Boolean(cfg.md_basic_auth),
      hasAccessTokenProducao: Boolean(cfg.md_access_token_producao),
      hasAccessTokenSandbox: Boolean(cfg.md_access_token_sandbox),
      idEmpresaIntegrada: cfg.md_id_empresa_integrada ?? null,
      sandbox: cfg.md_sandbox === '1',
      // Os valores reais são devolvidos para a instalação local usar nas chamadas à API.
      basicAuth: cfg.md_basic_auth ?? null,
      accessTokenProducao: cfg.md_access_token_producao ?? null,
      accessTokenSandbox: cfg.md_access_token_sandbox ?? null,
    });
  },
);

export default router;
