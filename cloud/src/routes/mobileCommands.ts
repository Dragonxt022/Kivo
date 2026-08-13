import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { requireMobileAuth, type MobileRequest } from '../mobileAuth';
import { emitToCompany, addClient, connectedCount } from '../events';

/**
 * Fila de comandos: o celular grava a INTENÇÃO, o computador da loja executa.
 *
 * O celular não pode escrever direto em `sync_records` porque o pull do desktop insere as
 * linhas direto nas tabelas, sem passar por `createQuote`/`createSale` — quem valida produto,
 * resolve preço pela tabela do cliente, move estoque e lança no caixa. Um orçamento escrito
 * assim chegaria como linha órfã, com preço de catálogo e sem validação nenhuma.
 *
 * São dois routers porque a autenticação difere: o celular vem por cookie de concessão, o
 * desktop por credenciais de licença. Mesmo mecanismo, dois lados.
 */

/** Permissões que cada tipo de comando exige de quem pediu — as mesmas chaves do desktop. */
const PERMISSAO_POR_TIPO: Record<string, string> = {
  'store.quote.create': 'store.quotes.create',
};

// ─── Lado do celular — montado em /api/mobile ──────────────────────────────────

export const mobileSide = Router();

mobileSide.post('/commands', requireMobileAuth, async (req: MobileRequest, res) => {
  const { kind, payload } = (req.body ?? {}) as { kind?: string; payload?: unknown };
  const permissao = kind ? PERMISSAO_POR_TIPO[kind] : undefined;
  if (!kind || !permissao) {
    res.status(400).json({ error: 'Tipo de comando desconhecido.' });
    return;
  }
  if (!req.grant!.permissions.includes(permissao)) {
    res.status(403).json({ error: 'Seu cargo não permite esta ação.' });
    return;
  }
  const [result] = await getPool().query(
    `INSERT INTO company_commands (company_uuid, kind, payload, created_by_user_uuid)
     VALUES (?, ?, CAST(? AS JSON), ?)`,
    [req.grant!.companyUuid, kind, JSON.stringify(payload ?? {}), req.grant!.userUuid],
  );
  const id = (result as { insertId: number }).insertId;
  // Acorda o desktop na hora, em vez de esperar o ciclo periódico.
  emitToCompany(req.grant!.companyUuid, 'command', { id, kind });
  res.status(202).json({
    id,
    // A tela usa isto para escolher entre "confirmando…" e "o computador da loja parece
    // desligado" — prometer resposta imediata sem ninguém escutando seria mentir.
    desktopOnline: connectedCount(req.grant!.companyUuid) > 0,
  });
});

/** A tela de status consulta aqui; o SSE abaixo encurta a espera para ~1s. */
mobileSide.get('/commands/:id', requireMobileAuth, async (req: MobileRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT id, kind, status, result FROM company_commands WHERE id = ? AND company_uuid = ?`,
    [req.params.id, req.grant!.companyUuid],
  );
  const row = (rows as { id: number; kind: string; status: string; result: string | object | null }[])[0];
  if (!row) {
    res.status(404).json({ error: 'Comando não encontrado.' });
    return;
  }
  res.json({ ...row, result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result });
});

mobileSide.get('/events', requireMobileAuth, (req: MobileRequest, res) => {
  addClient(req.grant!.companyUuid, res);
});

// ─── Lado do desktop — montado em /api/commands ────────────────────────────────

export const desktopSide = Router();

desktopSide.get('/pending', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    `SELECT id, kind, payload, created_by_user_uuid
       FROM company_commands
      WHERE company_uuid = ? AND status = 'pendente'
      ORDER BY id LIMIT 50`,
    [req.companyUuid],
  );
  res.json({
    commands: (rows as { id: number; kind: string; payload: string | object; created_by_user_uuid: string }[]).map((c) => ({
      ...c,
      payload: typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload,
    })),
  });
});

desktopSide.post('/:id/ack', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const { status, result } = (req.body ?? {}) as { status?: string; result?: unknown };
  if (status !== 'aplicado' && status !== 'erro') {
    res.status(400).json({ error: "status deve ser 'aplicado' ou 'erro'." });
    return;
  }
  // `status = 'pendente'` no WHERE torna o ack idempotente: um reenvio depois de timeout de
  // rede não sobrescreve o resultado que já foi gravado.
  await getPool().query(
    `UPDATE company_commands
        SET status = ?, result = CAST(? AS JSON), applied_at = NOW()
      WHERE id = ? AND company_uuid = ? AND status = 'pendente'`,
    [status, JSON.stringify(result ?? {}), req.params.id, req.companyUuid],
  );
  // Avisa o celular que está na tela de status esperando.
  emitToCompany(req.companyUuid!, 'command-done', { id: Number(req.params.id), status });
  res.json({ ok: true });
});

/** O desktop mantém esta conexão aberta para saber na hora que entrou comando. */
desktopSide.get('/events', requireCompanyAuth, (req: AuthedRequest, res) => {
  addClient(req.companyUuid!, res);
});
