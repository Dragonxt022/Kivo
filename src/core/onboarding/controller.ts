import type { Request, Response } from 'express';
import { audit } from '../audit/service';
import { assertAuth } from '../../shared/auth';
// `resetDemoData` não entra aqui: o nome é reaproveitado pelo destructuring do corpo da
// requisição logo abaixo, que sombreava o import e o deixava morto desde sempre.
import { EMPLOYEE_RANGES, getOnboardingStatus, listFeaturesForWizard, listPaymentMethodsForWizard, markOnboardingCompleted, provision, type OnboardingBusinessType, type OnboardingEmployeeRange, type OnboardingUsage } from './service';

const USAGE_VALUES = new Set(['balcao', 'mesas', 'ambos']);
const BUSINESS_TYPE_VALUES = new Set<string>([
  'restaurante', 'roupas', 'outro',
  'padaria', 'mercado', 'conveniencia', 'adega', 'farmacia', 'petshop', 'servicos',
]);
const EMPLOYEE_RANGE_VALUES = new Set<string>(EMPLOYEE_RANGES);

export const onboardingController = {
  status(_req: Request, res: Response) {
    res.json(getOnboardingStatus());
  },

  paymentMethods(_req: Request, res: Response) {
    res.json(listPaymentMethodsForWizard());
  },

  features(_req: Request, res: Response) {
    res.json(listFeaturesForWizard());
  },

  skip(req: Request, res: Response) {
    markOnboardingCompleted();
    audit(req, 'onboarding_pular', 'onboarding', 'skip');
    res.json({ ok: true });
  },

  provisionAction(req: Request, res: Response) {
    assertAuth(req);
    const { usage, businessType, businessName, employeeRange, activePaymentMethodIds, createDemoData, resetDemoData, activeFeatureKeys } = req.body ?? {};
    if (!USAGE_VALUES.has(usage)) {
      res.status(400).json({ error: 'Campo usage inválido (balcao, mesas ou ambos).' });
      return;
    }
    if (!BUSINESS_TYPE_VALUES.has(businessType)) {
      res.status(400).json({ error: 'Campo businessType inválido.' });
      return;
    }
    // Nome obrigatório só no primeiro acesso (createDemoData marca o fluxo first-run):
    // reabrir o assistente com o nome já cadastrado em Configurações → Empresa não pode
    // exigir digitá-lo de novo, e o service preserva o valor existente quando vem vazio.
    const nome = typeof businessName === 'string' ? businessName.trim().slice(0, 120) : '';
    if (createDemoData && !nome) {
      res.status(400).json({ error: 'Informe o nome do seu negócio.' });
      return;
    }
    if (employeeRange != null && !EMPLOYEE_RANGE_VALUES.has(String(employeeRange))) {
      res.status(400).json({ error: 'Campo employeeRange inválido (1-5, 6-50, 51-100 ou 100+).' });
      return;
    }
    const ids = Array.isArray(activePaymentMethodIds) ? activePaymentMethodIds.map(Number).filter((n) => !Number.isNaN(n)) : [];
    // Ausente (cliente antigo) ≠ lista vazia (o lojista desmarcou tudo): o primeiro caso
    // cai na recomendação lá no service, o segundo desliga mesmo. Por isso não há `?? []`.
    const featureKeys = Array.isArray(activeFeatureKeys)
      ? activeFeatureKeys.map(String)
      : undefined;
    const result = provision(req, {
      usage: usage as OnboardingUsage,
      businessType: businessType as OnboardingBusinessType,
      businessName: nome,
      employeeRange: (employeeRange as OnboardingEmployeeRange) ?? undefined,
      activePaymentMethodIds: ids,
      createDemoData: !!createDemoData,
      resetDemoData: !!resetDemoData,
      activeFeatureKeys: featureKeys,
    });
    audit(req, 'onboarding_concluir', 'onboarding', 'provision', null, result);
    res.json(result);
  },
};
