import type { Request } from 'express';
import { loadAuthUser, type AuthUser } from './service';

/**
 * Contexto de execução para código que roda FORA de uma requisição HTTP — o agendador de
 * sync e a fila de comandos vinda do Kivo Web.
 *
 * Os services de domínio recebem um `Request` porque é dele que saem duas coisas:
 * `assertAuth` (shared/auth.ts) exige `req.user`, e `audit` (core/audit/service.ts) lê
 * `req.user?.id`, `req.user?.username` e `req.ip`. Nada além disso é tocado — daí um objeto
 * mínimo bastar, em vez de simular uma requisição inteira.
 */

/**
 * Sem usuário: para tarefas que são da máquina, não de uma pessoa (o ciclo periódico de
 * sync). O `audit` aceita `req.user` ausente e grava a linha com usuário nulo, que é a
 * leitura honesta de "isto não foi ninguém que clicou".
 */
export function systemRequest(): Request {
  return { ip: 'kivo-sistema' } as unknown as Request;
}

/**
 * Com usuário: para ações que uma pessoa pediu de fora do desktop (orçamento criado pelo
 * celular). Precisa carregar o usuário real do banco — permissão e auditoria têm de sair no
 * nome de quem pediu, não de um usuário genérico de serviço.
 *
 * Devolve `null` se o usuário não existe mais, está inativo ou foi excluído: nesse caso o
 * comando falha em vez de rodar com privilégio de outra pessoa.
 */
export function impersonate(userId: number, ip = 'kivo-web'): (Request & { user: AuthUser }) | null {
  const user = loadAuthUser(userId);
  if (!user) return null;
  return { ip, user } as unknown as Request & { user: AuthUser };
}
