/**
 * Entrada rápida por perfil: o usuário aparece como um balão redondo na tela de login e
 * entra num clique, sem digitar senha.
 *
 * Existe para a loja de família, onde trocar de usuário custava tanto que todo mundo acabava
 * operando no MESMO login — e a auditoria deixava de dizer quem fez o quê. Um clique por
 * pessoa é mais barato que uma senha, então cada um volta a usar a própria conta.
 *
 * ── O limite que isto tem, e por quê ────────────────────────────────────────────────────
 * Entrar sem senha é uma decisão consciente do dono da loja: quem alcança o TECLADO daquele
 * computador entra como aquele usuário. O que NÃO pode acontecer é isso valer para quem não
 * está na máquina — com "Acesso pela rede local" ligado o Kivo escuta em 0.0.0.0, e sem a
 * checagem de loopback abaixo qualquer celular no Wi-Fi da loja entraria como o dono só
 * abrindo o endereço. Por isso:
 *
 *   1. as rotas de entrada rápida só respondem a chamadas da própria máquina (loopback);
 *   2. os perfis vivem numa tabela que NÃO sincroniza (migration 0056), então ligar a
 *      entrada rápida num computador não a libera nos outros.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { loadAuthUser, type AuthUser } from './service';
import { userRepository } from '../repositories/UserRepository';

/** Cores dos balões — as mesmas dos temas do app, para não destoar da interface. */
const CORES = ['#2563eb', '#16a34a', '#ff8000', '#e11d8f', '#7c5cff', '#0891b2', '#dc2626', '#65a30d'];

export interface QuickProfile {
  id: number;
  userId: number;
  name: string;
  username: string;
  /** Iniciais para o balão (ex.: "Maria Silva" → "MS"). */
  initials: string;
  color: string;
}

/**
 * A requisição veio da própria máquina?
 *
 * `req.ip` vem do Express e já respeita `trust proxy`. Aceita as três formas em que o
 * loopback aparece no Node conforme a pilha de rede: IPv4, IPv6 e IPv4 mapeado em IPv6.
 */
export function isLoopback(req: Request): boolean {
  const ip = (req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function iniciais(nome: string): string {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

/**
 * Perfis salvos nesta máquina, na ordem de uso mais recente — quem entra toda hora fica no
 * começo da fila, em vez de a lista ficar congelada na ordem de cadastro.
 *
 * Usuário inativo ou excluído some da lista sem precisar de limpeza: o JOIN filtra.
 */
export function listQuickProfiles(): QuickProfile[] {
  const rows = getSqlite()
    .prepare(
      `SELECT q.id, q.user_id, q.avatar_color, u.name, u.username
         FROM quick_login_profiles q
         JOIN users u ON u.id = q.user_id
        WHERE u.active = 1 AND u.deleted_at IS NULL
        ORDER BY COALESCE(q.last_used_at, q.created_at) DESC, u.name`,
    )
    .all() as { id: number; user_id: number; avatar_color: string; name: string; username: string }[];

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    username: r.username,
    initials: iniciais(r.name),
    color: r.avatar_color,
  }));
}

export function hasQuickProfile(userId: number): boolean {
  return !!getSqlite()
    .prepare('SELECT 1 FROM quick_login_profiles WHERE user_id = ?')
    .get(userId);
}

/** Liga a entrada rápida deste usuário nesta máquina. Idempotente. */
export function enableQuickProfile(userId: number): void {
  const cor = CORES[Math.floor(Math.random() * CORES.length)];
  getSqlite()
    .prepare(
      `INSERT INTO quick_login_profiles (user_id, avatar_color) VALUES (?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .run(userId, cor);
}

export function disableQuickProfile(userId: number): void {
  getSqlite().prepare('DELETE FROM quick_login_profiles WHERE user_id = ?').run(userId);
}

export interface QuickLoginResult {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

const SESSION_HOURS = 12;

/**
 * Troca um perfil por uma sessão. Só o chamador (routes.ts) decide se a origem é confiável —
 * aqui a única regra é o perfil existir e o usuário continuar ativo.
 */
export function quickLogin(profileId: number, ip?: string): QuickLoginResult | null {
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT q.user_id
         FROM quick_login_profiles q
         JOIN users u ON u.id = q.user_id
        WHERE q.id = ? AND u.active = 1 AND u.deleted_at IS NULL`,
    )
    .get(profileId) as { user_id: number } | undefined;
  if (!row) return null;

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.prepare(
    `INSERT INTO sessions (token, user_id, remember, expires_at, ip, machine) VALUES (?, ?, 0, ?, ?, ?)`,
  ).run(token, row.user_id, expiresAt, ip ?? null, os.hostname());
  db.prepare(`UPDATE quick_login_profiles SET last_used_at = datetime('now') WHERE id = ?`).run(profileId);
  userRepository.updateLastLogin(row.user_id);

  const user = loadAuthUser(row.user_id);
  return user ? { token, expiresAt, user } : null;
}
