import type { Response } from 'express';

/**
 * Canal de eventos nuvem → desktop (SSE).
 *
 * Webhook não serve aqui: webhook é a nuvem fazendo POST no receptor, e o computador da loja
 * está atrás de NAT, em internet residencial, sem IP público nem certificado. Invertendo quem
 * abre a conexão, o problema some — o desktop faz um GET e a nuvem segura a resposta aberta
 * para empurrar avisos por ela.
 *
 * WebSocket resolveria também, mas é bidirecional e exigiria a lib `ws` dos dois lados; aqui
 * o tráfego é só num sentido ("chegou comando"), então SSE dá conta com HTTP puro.
 *
 * As conexões vivem em memória, como as sessões do painel admin (adminAuth.ts). Se o processo
 * reiniciar, todo mundo reconecta — e o ciclo periódico do desktop cobre a janela.
 */

const clients = new Map<string, Set<Response>>();

/** Sem isso, proxy reverso e operadora derrubam a conexão ociosa em ~1 min. */
const HEARTBEAT_MS = 25_000;

export function addClient(companyUuid: string, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Respeitado pelo nginx: sem isso ele bufferiza a resposta e os eventos chegam em lote,
  // o que parece bug de código e é configuração de proxy.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': conectado\n\n');

  if (!clients.has(companyUuid)) clients.set(companyUuid, new Set());
  clients.get(companyUuid)!.add(res);

  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(beat);
    }
  }, HEARTBEAT_MS);
  beat.unref?.();

  const cleanup = () => {
    clearInterval(beat);
    const set = clients.get(companyUuid);
    set?.delete(res);
    if (set && set.size === 0) clients.delete(companyUuid);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/** Avisa as máquinas daquela empresa. Silencioso quando ninguém está conectado. */
export function emitToCompany(companyUuid: string, event: string, data: unknown = {}): void {
  const set = clients.get(companyUuid);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

/** Diagnóstico: quantas máquinas da empresa estão escutando agora. */
export function connectedCount(companyUuid: string): number {
  return clients.get(companyUuid)?.size ?? 0;
}
