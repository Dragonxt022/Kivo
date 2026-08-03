import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { fiscalController } from './controllers/FiscalController';

/**
 * API do módulo fiscal (/api/fiscal).
 *
 * `requireCapability('fiscal.nfce')` em TODAS as rotas: com o beta desligado a API responde
 * 403 `Recurso desativado: fiscal.nfce`, que a UI já traduz no modal "Ativar agora"
 * (`partials/capability-gate.ejs`). Nada aqui roda por acidente.
 */
const router = Router();

router.use(requireCapability('fiscal.nfce'));

// Configuração
router.get('/config', requirePermission('fiscal.config.view'), fiscalController.getState);
router.get('/readiness', requirePermission('fiscal.config.view'), fiscalController.getReadiness);
router.get('/municipios', requirePermission('fiscal.config.view'), fiscalController.listMunicipios);
router.put('/config', requirePermission('fiscal.config.edit'), fiscalController.saveConfig);
router.put('/empresa', requirePermission('fiscal.config.edit'), fiscalController.saveEmpresa);
router.put('/credenciais', requirePermission('fiscal.config.edit'), fiscalController.saveCredentials);
router.put('/ambiente', requirePermission('fiscal.config.edit'), fiscalController.setEnvironment);
router.post('/certificado', requirePermission('fiscal.config.edit'), fiscalController.uploadCertificate);
router.delete('/certificado', requirePermission('fiscal.config.edit'), fiscalController.removeCertificate);

// Documentos
router.get('/documentos', requirePermission('fiscal.documents.view'), fiscalController.listDocuments);
router.get('/documentos/venda/:saleId', requirePermission('fiscal.documents.view'), fiscalController.getBySale);

export default router;
