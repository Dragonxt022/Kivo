import type { Request, Response, NextFunction } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Cor de destaque da empresa. Deixou de ser uma preferência de navegador (localStorage) e
 * passou a ser configuração da empresa: o valor mora na tabela `settings` e é aplicado no
 * servidor, então vale em qualquer aparelho que abra este Kivo — inclusive pelo celular na
 * rede local (ver `themeColorLocals` e partials/theme-init.ejs).
 */
export const COLOR_KEY = 'interface.cor_destaque';
export const CUSTOM_COLOR_KEY = 'interface.cor_custom';
export const DEFAULT_COLOR = 'orange';
export const DEFAULT_CUSTOM_COLOR = '#ff8000';

export const COLOR_PRESETS = ['blue', 'green', 'orange', 'pink', 'black'] as const;
export type ColorPreset = (typeof COLOR_PRESETS)[number];

export function getColorTheme(): string {
  const v = settingsRepository.get(COLOR_KEY);
  if (!v) return DEFAULT_COLOR;
  return v === 'custom' || (COLOR_PRESETS as readonly string[]).includes(v) ? v : DEFAULT_COLOR;
}

export function getCustomColor(): string {
  const v = settingsRepository.get(CUSTOM_COLOR_KEY);
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_CUSTOM_COLOR;
}

/**
 * Publica a cor em `res.locals` para o `theme-init` aplicar já no primeiro byte (sem
 * piscar). Lê a cada requisição de página: mudar a cor em Configurações passa a valer no
 * próximo carregamento, em qualquer aparelho, sem reiniciar. O filtro tira /api e
 * /uploads, que são a maioria do volume e não renderizam HTML.
 */
export function themeColorLocals(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    next();
    return;
  }
  try {
    res.locals.corDestaque = getColorTheme();
    res.locals.corCustom = getCustomColor();
  } catch {
    // Banco ainda sem a tabela (instalação nova): cai no padrão em vez de estourar.
    res.locals.corDestaque = DEFAULT_COLOR;
    res.locals.corCustom = DEFAULT_CUSTOM_COLOR;
  }
  next();
}
