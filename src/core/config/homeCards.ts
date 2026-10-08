import type { Request, Response, NextFunction } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';
import { BUSINESS_TYPE_KEY } from './businessProfile';

/**
 * Ordem e visibilidade dos cards da tela inicial — **preferência da empresa**, não do navegador.
 *
 * Antes a ordem vivia em `localStorage` (`HOME_ORDER_KEY`): arrumar os cards no computador da
 * recepção não valia no tablet, no celular na rede local nem no modo navegador, e cada aparelho
 * mostrava uma tela diferente. Cor de destaque e logo já eram `settings` justamente por isso
 * (ver `themeColor.ts`), então a ordem passou a morar no mesmo lugar: a tabela `settings`, lida
 * no servidor e aplicada já no primeiro byte.
 *
 * Guardamos apenas os `href` dos cards, em ordem. O que não estiver na lista (módulo ligado
 * depois, permissão nova) entra no fim, e href que não existe mais é ignorado — assim a
 * preferência nunca some com um card nem trava o usuário fora de uma tela.
 */

export const CARDS_ORDER_KEY = 'interface.ordem_cards';
export const CARDS_HIDDEN_KEY = 'interface.cards_ocultos';
/** Reexportado de `businessProfile` para quem já importava daqui (assistente, etc.). */
export { BUSINESS_TYPE_KEY };

function lerLista(chave: string): string[] {
  try {
    const bruto = settingsRepository.get(chave);
    if (!bruto) return [];
    const valor: unknown = JSON.parse(bruto);
    if (!Array.isArray(valor)) return [];
    return valor.filter((v): v is string => typeof v === 'string' && v.startsWith('/')).slice(0, 200);
  } catch {
    // Preferência corrompida não pode derrubar a tela inicial.
    return [];
  }
}

export function getCardsOrder(): string[] {
  return lerLista(CARDS_ORDER_KEY);
}

export function getCardsHidden(): string[] {
  return lerLista(CARDS_HIDDEN_KEY);
}

export function saveCardsLayout(order: string[], hidden: string[]): void {
  settingsRepository.set(CARDS_ORDER_KEY, JSON.stringify(order.slice(0, 200)));
  settingsRepository.set(CARDS_HIDDEN_KEY, JSON.stringify(hidden.slice(0, 200)));
}

/**
 * Ordem inicial sugerida pelo perfil do negócio (o que a pessoa respondeu no primeiro acesso).
 * Só é usada quando a empresa NUNCA salvou uma ordem — depois disso, quem manda é a preferência
 * salva, para não atropelar a arrumação que a equipe já fez.
 */
const PRIORIDADES: { palavras: RegExp; hrefs: string[] }[] = [
  { palavras: /odonto|dent|clinic|saude|saúde/i, hrefs: ['/app/odonto', '/app/finance', '/app/pdv', '/app/produtos'] },
  { palavras: /merc|mercearia|supermerc|emporio|empório|hortifruti|acougue|açougue|padaria|distribuid/i, hrefs: ['/app/pdv', '/app/produtos', '/app/finance'] },
  { palavras: /farmacia|farmácia|drogaria|perfum/i, hrefs: ['/app/pdv', '/app/produtos', '/app/finance'] },
  { palavras: /restaurante|lanchonete|bar|pizza|food|delivery|acai|açaí|cafe|café|padaria|doceria/i, hrefs: ['/app/pdv', '/app/foodservice', '/app/produtos', '/app/finance'] },
  { palavras: /loja|varejo|moda|roupa|calcado|calçado|presente|papelaria|pet|material/i, hrefs: ['/app/pdv', '/app/produtos', '/app/finance'] },
  { palavras: /oficina|assistencia|assistência|servic|salão|salao|barbearia|estetica|estética/i, hrefs: ['/app/pdv', '/app/finance', '/app/produtos'] },
];

/** Hrefs preferidos para o perfil; lista vazia quando o perfil é desconhecido. */
export function priorityForBusinessType(tipo: string): string[] {
  const achou = PRIORIDADES.find((p) => p.palavras.test(tipo));
  return achou ? achou.hrefs : [];
}

/**
 * Reordena os cards: o que casa com a prioridade vem primeiro (na ordem da prioridade), o resto
 * mantém a ordem em que o servidor mandou. Estável de propósito — dois cards do mesmo módulo não
 * trocam de lugar entre si.
 */
export function applyPriority<T extends { href: string }>(cards: T[], prioridades: string[]): T[] {
  if (!prioridades.length) return cards;
  const peso = (href: string): number => {
    const i = prioridades.findIndex((p) => href.startsWith(p));
    return i === -1 ? prioridades.length + 1 : i;
  };
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => peso(a.c.href) - peso(b.c.href) || a.i - b.i)
    .map((x) => x.c);
}

/** Ordem salva aplicada sobre a lista de cards: os conhecidos na ordem salva, os novos no fim. */
export function applySavedOrder<T extends { href: string }>(cards: T[], ordem: string[]): T[] {
  if (!ordem.length) return cards;
  const posicao = new Map(ordem.map((href, i) => [href, i]));
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = posicao.has(a.c.href) ? (posicao.get(a.c.href) as number) : ordem.length + a.i;
      const pb = posicao.has(b.c.href) ? (posicao.get(b.c.href) as number) : ordem.length + b.i;
      return pa - pb;
    })
    .map((x) => x.c);
}

/** Publica a preferência em `res.locals` (o `home.ejs` já monta a lista na ordem certa). */
export function homeCardsLocals(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    next();
    return;
  }
  try {
    res.locals.ordemCards = getCardsOrder();
    res.locals.cardsOcultos = getCardsHidden();
    const tipo = settingsRepository.get(BUSINESS_TYPE_KEY) ?? '';
    // Sem ordem salva, a sugestão vem do perfil respondido no boas-vindas.
    res.locals.prioridadeCards = res.locals.ordemCards.length ? [] : priorityForBusinessType(tipo);
  } catch {
    res.locals.ordemCards = [];
    res.locals.cardsOcultos = [];
    res.locals.prioridadeCards = [];
  }
  next();
}
