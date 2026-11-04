import fs from 'node:fs';
import path from 'node:path';

/**
 * Sons de aviso disponíveis no aparelho.
 *
 * A lista é lida da pasta `public/sons` em vez de ficar duplicada/hardcoded nas telas:
 * quando o lojista adiciona `pedido9.mp3`, ele aparece sozinho no seletor da Cozinha e
 * das Mesas. O rótulo sai do nome (`pedido.mp3` = Pedido 1, `pedido2.mp3` = Pedido 2).
 */
export interface NotificationSound {
  label: string;
  file: string;
}

const FALLBACK_FILES = [
  'pedido.mp3',
  'pedido2.mp3',
  'pedido3.mp3',
  'pedido4.mp3',
  'pedido5.mp3',
  'pedido6.mp3',
  'pedido7.mp3',
  'pedido8.mp3',
];

function labelFor(file: string): string {
  const match = /^pedido(\d*)\.(mp3|wav|ogg)$/i.exec(file);
  if (match) {
    const number = match[1] ? Number(match[1]) : 1;
    return `Pedido ${Number.isFinite(number) && number > 0 ? number : 1}`;
  }
  const base = file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : file;
}

function order(a: string, b: string): number {
  const na = /^pedido(\d*)\./i.exec(a);
  const nb = /^pedido(\d*)\./i.exec(b);
  if (na && nb) {
    const va = na[1] ? Number(na[1]) : 1;
    const vb = nb[1] ? Number(nb[1]) : 1;
    if (va !== vb) return va - vb;
  }
  return a.localeCompare(b, 'pt-BR');
}

/** Arquivos de som encontrados em `public/sons`; fallback fixo se a pasta não existir. */
export function notificationSounds(): NotificationSound[] {
  try {
    // __dirname: src/core/sound (dev) ou dist/core/sound (build). Sobe até a raiz do
    // projeto e entra em public/sons — o build copia a pasta para dist/public/sons.
    const dir = path.resolve(__dirname, '..', '..', 'public', 'sons');
    const files = fs
      .readdirSync(dir)
      .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
      .sort(order);
    if (files.length) return files.map((file) => ({ file, label: labelFor(file) }));
  } catch {
    // Instalação sem a pasta de sons: a tela continua com os avisos padrão.
  }
  return FALLBACK_FILES.map((file) => ({ file, label: labelFor(file) }));
}
