import { getSecret, hasSecret, setSecret } from '../../core/secrets/service';
import { settingsRepository } from '../../core/repositories/SettingsRepository';

/**
 * Configuração não secreta da integração. Token e Basic Auth NÃO passam por aqui:
 * ficam no cofre (`core/secrets`), porque `settings` é devolvido pela API e copiado
 * no backup. O que a tela recebe é só `hasAccessToken` / `hasBasicAuth`.
 */
const SETTING_EMPRESA = 'maisdelivery.empresa_integrada';
const SETTING_RESTAURANTE = 'maisdelivery.restaurante';
const SETTING_MARKETPLACE = 'maisdelivery.marketplace';
const SETTING_SANDBOX = 'maisdelivery.sandbox';
/** Situação do marketplace correspondente à etapa da cozinha (aprendida no uso). */
const SETTING_SITUACAO_PREPARO = 'maisdelivery.situacao_preparo';
const SETTING_SITUACAO_PRONTO = 'maisdelivery.situacao_pronto';

export const MAISDELIVERY_ACCESS_TOKEN_SECRET = 'maisdelivery.access_token';
export const MAISDELIVERY_BASIC_AUTH_SECRET = 'maisdelivery.basic_auth';

export interface MaisDeliveryConfig {
  empresaIntegrada: number | null;
  restaurante: number | null;
  marketplace: number | null;
  /** A API usa `sandBox` no corpo (com B maiúsculo, como nos exemplos oficiais). */
  sandbox: boolean;
  hasAccessToken: boolean;
  hasBasicAuth: boolean;
}

export interface MaisDeliveryConfigInput {
  empresaIntegrada?: number | null;
  restaurante?: number | null;
  marketplace?: number | null;
  sandbox?: boolean;
  /** Vazio/ausente mantém o segredo atual; string preenchida substitui. */
  accessToken?: string;
  basicAuth?: string;
}

function intSetting(key: string): number | null {
  const raw = settingsRepository.get(key);
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function boolSetting(key: string, fallback: boolean): boolean {
  const raw = settingsRepository.get(key);
  if (raw == null) return fallback;
  return raw === '1';
}

export function getMaisDeliveryConfig(): MaisDeliveryConfig {
  return {
    empresaIntegrada: intSetting(SETTING_EMPRESA),
    restaurante: intSetting(SETTING_RESTAURANTE),
    marketplace: intSetting(SETTING_MARKETPLACE),
    sandbox: boolSetting(SETTING_SANDBOX, true),
    hasAccessToken: hasSecret(MAISDELIVERY_ACCESS_TOKEN_SECRET),
    hasBasicAuth: hasSecret(MAISDELIVERY_BASIC_AUTH_SECRET),
  };
}

function setIntSetting(key: string, value: number | null | undefined): void {
  if (value === undefined) return;
  settingsRepository.set(key, value && value > 0 ? String(value) : '');
}

export function saveMaisDeliveryConfig(input: MaisDeliveryConfigInput): MaisDeliveryConfig {
  setIntSetting(SETTING_EMPRESA, input.empresaIntegrada);
  setIntSetting(SETTING_RESTAURANTE, input.restaurante);
  setIntSetting(SETTING_MARKETPLACE, input.marketplace);
  if (input.sandbox !== undefined) {
    settingsRepository.set(SETTING_SANDBOX, input.sandbox ? '1' : '0');
  }
  if (input.accessToken?.trim()) {
    setSecret(MAISDELIVERY_ACCESS_TOKEN_SECRET, input.accessToken.trim());
  }
  if (input.basicAuth?.trim()) {
    setSecret(MAISDELIVERY_BASIC_AUTH_SECRET, input.basicAuth.trim());
  }
  return getMaisDeliveryConfig();
}

/** Configuração mínima para listar/consultar pedidos.
 *
 * As credenciais (Access token e Basic Auth) ficam agora na nuvem, então esta
 * checagem só verifica os IDs locais: empresa integrada + restaurante/marketplace
 * (código de integração da loja). O token é validado na chamada à API via cloud.
 */
export function isMaisDeliveryConfigured(config = getMaisDeliveryConfig()): boolean {
  return Boolean(
    config.empresaIntegrada &&
    (config.restaurante || config.marketplace),
  );
}

/**
 * Lê e decifra as credenciais. `null` cobre tanto "nunca salvou" quanto "foi gravado
 * em outra máquina e não dá mais para decifrar" — a mensagem do chamador deve pedir
 * para salvar de novo.
 */
export function getMaisDeliveryCredentials(): { accessToken: string; basicAuth: string } | null {
  const accessToken = getSecret(MAISDELIVERY_ACCESS_TOKEN_SECRET);
  const basicAuth = getSecret(MAISDELIVERY_BASIC_AUTH_SECRET);
  if (!accessToken || !basicAuth) return null;
  return { accessToken, basicAuth };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ponte cozinha ⇆ marketplace. Os ids de situação "em preparo" / "pronto" são
// específicos da conta do lojista na API (operação 7), então a ponte APRENDE a
// primeira vez em que precisar deles e guarda aqui. `null` = ainda não combinada:
// a mudança de status é pulada, nunca chuteada pelo id errado.
// ─────────────────────────────────────────────────────────────────────────────

export type KitchenSituationSlot = 'preparo' | 'pronto';

export interface KitchenSituations {
  preparo: number | null;
  pronto: number | null;
}

export function getKitchenSituations(): KitchenSituations {
  return {
    preparo: intSetting(SETTING_SITUACAO_PREPARO),
    pronto: intSetting(SETTING_SITUACAO_PRONTO),
  };
}

export function saveKitchenSituations(situations: Partial<KitchenSituations>): void {
  if (situations.preparo !== undefined) setIntSetting(SETTING_SITUACAO_PREPARO, situations.preparo);
  if (situations.pronto !== undefined) setIntSetting(SETTING_SITUACAO_PRONTO, situations.pronto);
}
