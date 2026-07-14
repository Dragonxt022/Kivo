import type { Request, Response } from 'express';
import { audit } from '../audit/service';
import { assertAuth } from '../../shared/auth';
import { getOnboardingStatus, listPaymentMethodsForWizard, markOnboardingCompleted, provision, resetDemoData, type OnboardingBusinessType, type OnboardingUsage } from './service';

const USAGE_VALUES = new Set(['balcao', 'mesas', 'ambos']);
const BUSINESS_TYPE_VALUES = new Set(['restaurante', 'roupas', 'outro']);

export const onboardingController = {
  status(_req: Request, res: Response) {
    res.json(getOnboardingStatus());
  },

  paymentMethods(_req: Request, res: Response) {
    res.json(listPaymentMethodsForWizard());
  },

  skip(req: Request, res: Response) {
    markOnboardingCompleted();
    audit(req, 'onboarding_pular', 'onboarding', 'skip');
    res.json({ ok: true });
  },

  provisionAction(req: Request, res: Response) {
    assertAuth(req);
    const { usage, businessType, activePaymentMethodIds, createDemoData, resetDemoData } = req.body ?? {};
    if (!USAGE_VALUES.has(usage)) {
      res.status(400).json({ error: 'Campo usage inválido (balcao, mesas ou ambos).' });
      return;
    }
    if (!BUSINESS_TYPE_VALUES.has(businessType)) {
      res.status(400).json({ error: 'Campo businessType inválido (restaurante, roupas ou outro).' });
      return;
    }
    const ids = Array.isArray(activePaymentMethodIds) ? activePaymentMethodIds.map(Number).filter((n) => !Number.isNaN(n)) : [];
    const result = provision(req, {
      usage: usage as OnboardingUsage,
      businessType: businessType as OnboardingBusinessType,
      activePaymentMethodIds: ids,
      createDemoData: !!createDemoData,
      resetDemoData: !!resetDemoData,
    });
    audit(req, 'onboarding_concluir', 'onboarding', 'provision', null, result);
    res.json(result);
  },
};
