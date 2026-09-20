import type { Request, Response, NextFunction } from 'express';
import { settingsRepository } from '../repositories/SettingsRepository';
import type { ModuleMenuItem } from '../modules/types';

/**
 * Rótulo do módulo de comandas. Uma loja que atende "só no balcão" (resposta do
 * assistente) não deveria ver "Mesas" no menu: chamamos de "Balcão" e trocamos o ícone.
 * A escolha é uma configuração da empresa (tabela `settings`), então vale para todos os
 * aparelhos que abrem este Kivo — inclusive pelo celular na rede local.
 */
export type ComandasRotulo = 'mesa' | 'balcao';

const ROTULO_KEY = 'comandas.rotulo';

export function getComandasRotulo(): ComandasRotulo {
  return settingsRepository.get(ROTULO_KEY) === 'balcao' ? 'balcao' : 'mesa';
}

export function setComandasRotulo(rotulo: ComandasRotulo): void {
  settingsRepository.set(ROTULO_KEY, rotulo);
}

/**
 * Todos os textos que mudam com o rótulo. Guardamos as frases prontas (e não um singular
 * para concatenar) porque o português troca o gênero: "Mesa criada" vira "Balcão criado",
 * e montar isso no meio da tela daria "Balcão criada".
 */
export interface ComandasLabels {
  rotulo: ComandasRotulo;
  plural: string;
  singular: string;
  novo: string;
  removerTitulo: string;
  criada: string;
  removida: string;
  vazia: string;
  novoDialogo: string;
  placeholder: string;
  transferirTitulo: string;
  transferirTexto: string;
  nenhumaLivre: string;
  descricao: string;
  icon: string;
}

const MESA: ComandasLabels = {
  rotulo: 'mesa',
  plural: 'Mesas',
  singular: 'mesa',
  novo: 'Nova mesa',
  removerTitulo: 'Remover mesa',
  criada: 'Mesa criada.',
  removida: 'Mesa removida.',
  vazia: 'Nenhuma mesa cadastrada ainda.',
  novoDialogo: 'Nova mesa',
  placeholder: 'Ex.: Mesa 5',
  transferirTitulo: 'Transferir para mesa',
  transferirTexto: 'Escolha a mesa de destino:',
  nenhumaLivre: 'Nenhuma mesa livre no momento.',
  descricao: 'Mesas e comandas abertas.',
  icon: 'utensils',
};

const BALCAO: ComandasLabels = {
  rotulo: 'balcao',
  plural: 'Balcão',
  singular: 'balcão',
  novo: 'Novo balcão',
  removerTitulo: 'Remover balcão',
  criada: 'Balcão criado.',
  removida: 'Balcão removido.',
  vazia: 'Nenhum balcão cadastrado ainda.',
  novoDialogo: 'Novo balcão',
  placeholder: 'Ex.: Balcão 1',
  transferirTitulo: 'Transferir para balcão',
  transferirTexto: 'Escolha o balcão de destino:',
  nenhumaLivre: 'Nenhum balcão livre no momento.',
  descricao: 'Comandas de balcão abertas.',
  icon: 'counter',
};

export function getComandasLabels(): ComandasLabels {
  return getComandasRotulo() === 'balcao' ? BALCAO : MESA;
}

/**
 * Publica os rótulos em `res.locals` e renomeia o item do módulo no menu. Precisa rodar
 * DEPOIS de `filterModuleMenu` (que preenche `res.locals.moduleMenu`) e antes das views.
 */
export function businessLabelsLocals(req: Request, res: Response, next: NextFunction): void {
  // Só requisição que vira HTML: /api e /uploads não renderizam menu e evitam a leitura.
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    next();
    return;
  }
  const labels = getComandasLabels();
  res.locals.comandasLabels = labels;
  const menu = res.locals.moduleMenu as ModuleMenuItem[] | undefined;
  if (menu && labels.rotulo === 'balcao') {
    res.locals.moduleMenu = menu.map((item) =>
      item.href === '/app/comandas/mesas'
        ? { ...item, label: labels.plural, icon: labels.icon, description: labels.descricao }
        : item,
    );
  }
  next();
}
