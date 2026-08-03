import type { Request, Response } from 'express';
import { audit } from '../../../core/audit/service';
import {
  backToHomologation,
  getConfig,
  getEmpresa,
  hasCsc,
  hasProviderToken,
  promoteToProduction,
  saveConfig,
  saveEmpresa,
  setCsc,
  setProviderToken,
  type EmpresaFiscal,
  type FiscalConfig,
} from '../services/config';
import { currentCertificate, removeCertificate, storeCertificate } from '../services/certificate';
import { checkReadiness } from '../services/readiness';
import { listMunicipios } from '../services/municipios';
import { fiscalDocumentRepository, fiscalSequenceRepository } from '../repositories/FiscalDocumentRepository';

/** Certificado A1 típico tem entre 2 KB e 20 KB; 1 MB já é folga enorme e evita que um
 * arquivo trocado por engano (um PDF, um ZIP) chegue ao parser. */
const MAX_CERT_BYTES = 1024 * 1024;

function fail(res: Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

export const fiscalController = {
  /**
   * Estado completo da configuração numa chamada só — a tela precisa de tudo junto para
   * decidir se abre o assistente ou o painel, e três fetches encadeados só piorariam a
   * primeira renderização.
   *
   * Segredos nunca voltam no corpo: apenas se estão preenchidos.
   */
  getState(_req: Request, res: Response): void {
    const cfg = getConfig();
    res.json({
      config: cfg,
      empresa: getEmpresa(),
      certificado: currentCertificate(),
      temCsc: hasCsc(),
      temToken: hasProviderToken(),
      readiness: checkReadiness(),
      proximoNumero: fiscalSequenceRepository.peek(cfg.modelo, cfg.serie, cfg.ambiente),
    });
  },

  getReadiness(_req: Request, res: Response): void {
    res.json(checkReadiness());
  },

  saveEmpresa(req: Request, res: Response): void {
    const before = getEmpresa();
    saveEmpresa((req.body ?? {}) as Partial<EmpresaFiscal>);
    const after = getEmpresa();
    audit(req, 'editar', 'fiscal_empresa', 'empresa', before, after);
    res.json({ ok: true, empresa: after, readiness: checkReadiness() });
  },

  saveConfig(req: Request, res: Response): void {
    const before = getConfig();
    saveConfig((req.body ?? {}) as Partial<FiscalConfig>);
    const after = getConfig();
    audit(req, 'editar', 'fiscal_config', 'config', before, after);
    res.json({ ok: true, config: after, readiness: checkReadiness() });
  },

  /**
   * Upload do .pfx em base64 no corpo JSON — mesmo caminho das fotos de produto
   * (`express.json({ limit: '10mb' })`), já que o projeto não tem parser de multipart.
   * A senha vem junto e só existe em memória até ir para o cofre.
   */
  uploadCertificate(req: Request, res: Response): void {
    const { pfxBase64, senha } = (req.body ?? {}) as { pfxBase64?: string; senha?: string };
    if (!pfxBase64) return fail(res, 'Envie o arquivo do certificado (.pfx ou .p12).');
    if (!senha) return fail(res, 'Informe a senha do certificado.');

    let buf: Buffer;
    try {
      buf = Buffer.from(String(pfxBase64), 'base64');
    } catch {
      return fail(res, 'Arquivo inválido.');
    }
    if (!buf.length) return fail(res, 'Arquivo vazio.');
    if (buf.length > MAX_CERT_BYTES) return fail(res, 'Arquivo grande demais para ser um certificado A1.');

    const result = storeCertificate(buf, String(senha));
    if (!result.ok) return fail(res, result.error);

    // Nunca logar senha nem conteúdo — só o titular e a validade, que já são exibidos na tela.
    audit(req, 'editar', 'fiscal_certificado', result.info.titular, null, {
      titular: result.info.titular,
      validoAte: result.info.validoAte,
    });
    res.json({ ok: true, certificado: result.info, readiness: checkReadiness() });
  },

  removeCertificate(req: Request, res: Response): void {
    removeCertificate();
    audit(req, 'excluir', 'fiscal_certificado', 'certificado');
    res.json({ ok: true, readiness: checkReadiness() });
  },

  /** Grava CSC e token. Recebe e descarta — nada disso volta em nenhuma resposta. */
  saveCredentials(req: Request, res: Response): void {
    const { csc, idCsc, provider, token } = (req.body ?? {}) as Record<string, string | undefined>;
    if (csc != null) setCsc(String(csc));
    if (token != null) setProviderToken(String(token));
    if (idCsc != null || provider != null) saveConfig({ idCsc, provider });
    audit(req, 'editar', 'fiscal_credenciais', 'credenciais', null, {
      idCsc: idCsc ?? getConfig().idCsc,
      provider: provider ?? getConfig().provider,
      cscAtualizado: csc != null,
      tokenAtualizado: token != null,
    });
    res.json({ ok: true, temCsc: hasCsc(), temToken: hasProviderToken(), readiness: checkReadiness() });
  },

  async listMunicipios(req: Request, res: Response): Promise<void> {
    try {
      res.json(await listMunicipios(String(req.query.uf ?? '')));
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'Não foi possível carregar os municípios.');
    }
  },

  /** Trava do beta: só sai de homologação com uma emissão de teste autorizada. */
  setEnvironment(req: Request, res: Response): void {
    const { ambiente } = (req.body ?? {}) as { ambiente?: number };
    if (ambiente !== 1 && ambiente !== 2) return fail(res, 'Ambiente inválido.');

    if (ambiente === 2) {
      backToHomologation();
      audit(req, 'editar', 'fiscal_ambiente', 'ambiente', { ambiente: 1 }, { ambiente: 2 });
      res.json({ ok: true, config: getConfig(), readiness: checkReadiness() });
      return;
    }

    const result = promoteToProduction();
    if (!result.ok) return fail(res, result.error);
    audit(req, 'editar', 'fiscal_ambiente', 'ambiente', { ambiente: 2 }, { ambiente: 1 });
    res.json({ ok: true, config: getConfig(), readiness: checkReadiness() });
  },

  listDocuments(req: Request, res: Response): void {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json(
      fiscalDocumentRepository.raw(
        `SELECT d.*, s.id AS venda FROM fiscal_documents d
         LEFT JOIN sales s ON s.id = d.sale_id
         WHERE d.deleted_at IS NULL
         ORDER BY d.id DESC LIMIT ?`,
        limit,
      ),
    );
  },

  getBySale(req: Request, res: Response): void {
    const doc = fiscalDocumentRepository.findBySale(Number(req.params.saleId));
    if (!doc) {
      res.json(null);
      return;
    }
    res.json(doc);
  },
};
