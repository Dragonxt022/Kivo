/**
 * Resgate de senha por código de desafio/resposta, ditado pelo suporte.
 *
 * Por que não e-mail: o `password_hash` mora no SQLite desta máquina. Um link de
 * recuperação chegaria no celular do lojista e teria que alcançar um servidor em
 * `localhost:3123`, atrás de NAT — o mesmo motivo pelo qual o Kivo Web usa SSE em vez de
 * webhook. Além disso o PDV precisa se recuperar com a internet caída, que é justamente
 * quando e-mail não chega.
 *
 * O fluxo aqui é o último recurso. O caminho normal continua sendo outro administrador
 * redefinindo em Usuários; este cobre o caso em que o administrador é único.
 *
 * Segurança, com as escolhas explícitas:
 * - O segredo é POR EMPRESA, entregue pela nuvem e guardado no cofre (`core/secrets`).
 *   Não existe chave mestra no instalador — com "Rede local" ligada o app escuta em
 *   0.0.0.0 (ver `electron/main.ts`), então uma chave extraída do binário destravaria
 *   qualquer Kivo alcançável pela rede da loja. Este segredo só vale para esta empresa,
 *   e para lê-lo já é preciso ter acesso ao disco da máquina.
 * - A resposta tem 48 bits. O que segura a força bruta é o limite de tentativas por
 *   desafio somado ao rate limit da rota — não o tamanho do código, que precisa caber
 *   numa ligação telefônica.
 * - Conferir a identidade de quem liga é trabalho do atendente, não do código. O que o
 *   sistema garante é que sem passar pelo suporte não há resgate, e que toda troca fica
 *   registrada em `audit_logs`.
 */
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { getSecret } from '../secrets/service';
import { RECOVERY_SECRET_KEY, machineId, validateLicense } from '../license/service';
import { hashPassword } from '../auth/service';
import { audit } from '../audit/service';
import { validatePasswordStrength } from '../../shared/validation';
import { generateChallenge, verifyResponse } from './codes';

/** Depois disso o desafio morre: o lojista pede outro, e o antigo não volta a valer. */
const EXPIRA_MINUTOS = 30;

/** Tentativas por desafio. Errou 5 vezes, gera um novo — e o novo tem outra resposta. */
const MAX_TENTATIVAS = 5;

interface ChallengeRow {
  id: number;
  challenge: string;
  user_id: number;
  attempts: number;
  created_at: string;
  used_at: string | null;
}

interface TargetUser {
  id: number;
  username: string;
  name: string;
}

export type RecoveryError =
  | 'sem_segredo'
  | 'usuario_desconhecido'
  | 'desafio_desconhecido'
  | 'desafio_expirado'
  | 'tentativas_esgotadas'
  | 'codigo_incorreto'
  | 'senha_fraca';

export interface RecoveryAvailability {
  /** O resgate por código pode ser usado agora nesta máquina? */
  disponivel: boolean;
  /** Quantos usuários ativos poderiam redefinir a senha de outro pelo caminho normal. */
  administradores: number;
  supportPhone: string | null;
  supportEmail: string | null;
  /** Mostrado ao suporte para confirmar de qual instalação a pessoa está ligando. */
  instalacao: string;
}

/**
 * `datetime('now')` do SQLite grava UTC sem sufixo, e `new Date(...)` leria como horário
 * local — mesmo cuidado de `parseSqliteUtc` em `license/service.ts`.
 */
function parseSqliteUtc(s: string): number {
  return new Date(`${s.replace(' ', 'T')}Z`).getTime();
}

function secret(): string | null {
  return getSecret(RECOVERY_SECRET_KEY);
}

/**
 * Quantos usuários ativos têm `users.edit` — isto é, quantas pessoas conseguem redefinir a
 * senha de outra pela tela de Usuários, sem precisar do suporte. Um só significa que a
 * loja está a uma senha esquecida de ficar trancada para fora do próprio sistema.
 */
export function countPasswordResetters(): number {
  const row = getSqlite()
    .prepare(
      // `role_permissions` guarda a chave da permissão em texto (`permission_key`), não um
      // id para `permissions` — o curinga '*' dos cargos de fábrica já vem expandido em
      // linhas concretas pelo seed, então basta procurar a chave.
      `SELECT COUNT(DISTINCT u.id) AS total
         FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
        WHERE u.deleted_at IS NULL AND u.active = 1 AND rp.permission_key = 'users.edit'`,
    )
    .get() as { total: number };
  return row.total;
}

/** Estado que a tela de login precisa antes de oferecer (ou não) o resgate. */
export function availability(): RecoveryAvailability {
  const info = validateLicense();
  return {
    disponivel: !!secret(),
    administradores: countPasswordResetters(),
    supportPhone: info.supportPhone,
    supportEmail: info.supportEmail,
    instalacao: machineId().slice(0, 8).toUpperCase(),
  };
}

function findUser(username: string): TargetUser | undefined {
  return getSqlite()
    .prepare(
      `SELECT id, username, name FROM users
        WHERE username = ? AND deleted_at IS NULL AND active = 1`,
    )
    .get(String(username).trim().toLowerCase()) as TargetUser | undefined;
}

export type StartResult =
  | { ok: true; challenge: string; user: { username: string; name: string }; expiraEm: number }
  | { ok: false; error: RecoveryError };

/**
 * Abre um resgate para um usuário. O nome de usuário é digitado (em vez de escolhido numa
 * lista) para não expor quem trabalha na loja a quem só alcançou a tela de login pela rede.
 *
 * Usuário inexistente é dito com todas as letras, e não escondido atrás de uma resposta
 * genérica: quem errou o próprio usuário precisa saber disso agora, e não depois de ligar
 * para o suporte e receber um código que nunca ia funcionar. O que esse retorno entrega a
 * um curioso — se "joao" existe — a tela de login já entregaria de qualquer jeito.
 */
export function startRecovery(username: string): StartResult {
  if (!secret()) return { ok: false, error: 'sem_segredo' };
  const user = findUser(username);
  if (!user) return { ok: false, error: 'usuario_desconhecido' };

  const db = getSqlite();
  // Um resgate aberto por vez, por usuário: sem isso, gerar desafio virava uma forma de
  // acumular alvos e tentar 5 palpites em cada um.
  db.prepare(`UPDATE password_recovery SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(user.id);

  const challenge = generateChallenge();
  db.prepare('INSERT INTO password_recovery (challenge, user_id) VALUES (?, ?)').run(challenge, user.id);

  return {
    ok: true,
    challenge,
    user: { username: user.username, name: user.name },
    expiraEm: EXPIRA_MINUTOS,
  };
}

export type CompleteResult =
  | { ok: true; username: string }
  | { ok: false; error: RecoveryError; detalhe?: string; tentativasRestantes?: number };

/**
 * Fecha o resgate: confere a resposta ditada pelo suporte e troca a senha.
 *
 * A senha nova vem junto na mesma chamada de propósito. Se a verificação apenas
 * "destravasse" a troca, existiria uma janela entre destravar e trocar — e nela qualquer
 * um na rede da loja completaria a troca sem nunca ter tido o código.
 */
export function completeRecovery(
  req: Request,
  input: { challenge: string; response: string; newPassword: string },
): CompleteResult {
  const key = secret();
  if (!key) return { ok: false, error: 'sem_segredo' };

  const db = getSqlite();
  const row = db
    .prepare('SELECT * FROM password_recovery WHERE challenge = ? AND used_at IS NULL')
    .get(String(input.challenge).trim()) as ChallengeRow | undefined;
  if (!row) return { ok: false, error: 'desafio_desconhecido' };

  if (Date.now() - parseSqliteUtc(row.created_at) > EXPIRA_MINUTOS * 60_000) {
    db.prepare(`UPDATE password_recovery SET used_at = datetime('now') WHERE id = ?`).run(row.id);
    return { ok: false, error: 'desafio_expirado' };
  }
  if (row.attempts >= MAX_TENTATIVAS) return { ok: false, error: 'tentativas_esgotadas' };

  // Conta a tentativa ANTES de verificar: se a validação estourar no meio, o palpite já
  // foi cobrado. Contar só no caminho de erro deixaria o contador zerado num crash.
  db.prepare('UPDATE password_recovery SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  if (!verifyResponse(key, row.challenge, String(input.response))) {
    return {
      ok: false,
      error: 'codigo_incorreto',
      tentativasRestantes: Math.max(0, MAX_TENTATIVAS - (row.attempts + 1)),
    };
  }

  // Só depois do código certo — quem não passou pelo suporte não descobre por aqui qual é
  // a política de senha nem consome tentativa à toa testando senhas.
  const pwError = validatePasswordStrength(String(input.newPassword));
  if (pwError) return { ok: false, error: 'senha_fraca', detalhe: pwError };

  const user = db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(row.user_id) as TargetUser | undefined;
  if (!user) return { ok: false, error: 'usuario_desconhecido' };

  db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hashPassword(String(input.newPassword)), user.id);
    // Toda sessão aberta desse usuário cai. Se a senha foi perdida, não dá para assumir
    // que quem estivesse logado em outro terminal ainda deveria continuar.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare(`UPDATE password_recovery SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  })();

  // Sem `req.user` (a rota é pública, ninguém está logado): o log registra a ação, o
  // usuário afetado e o IP de onde partiu — que é o que se quer auditar aqui.
  audit(req, 'senha_resgatada', 'user', user.id, null, {
    username: user.username,
    via: 'codigo_de_suporte',
    desafio: row.challenge,
  });

  return { ok: true, username: user.username };
}

/**
 * Higiene: desafios consumidos ou vencidos não têm serventia nenhuma depois. Chamado no
 * boot para a tabela não crescer sem limite numa instalação que use isso com frequência.
 */
export function purgeOldChallenges(): void {
  getSqlite()
    .prepare(`DELETE FROM password_recovery WHERE created_at < datetime('now', '-7 days')`)
    .run();
}
