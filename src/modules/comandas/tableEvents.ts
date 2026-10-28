import type { Response } from 'express';

/**
 * Canal de atualização da grade de mesas.
 *
 * A tela de mesas costuma ficar aberta no caixa enquanto os garçons abrem e fecham
 * contas pelo celular. O poll de 10 s (e o navegador, que atrasa timers em segundo
 * plano) fazia a mesa continuar "Livre"/"Ocupada" por bastante tempo. Este SSE avisa
 * na hora em que qualquer comanda/mesa muda; o poll continua como rede de segurança
 * caso a conexão caia.
 */
const clients = new Set<Response>();
let heartbeat: NodeJS.Timeout | null = null;

function stopHeartbeatIfEmpty(): void {
  if (clients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

export function subscribeTableEvents(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Sem isto, um proxy (ou o próprio navegador, com buffer) pode segurar os eventos.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Comentário inicial: fecha os headers no cliente sem disparar nenhuma ação.
  res.write(': conectado\n\n');
  clients.add(res);

  if (!heartbeat) {
    // Mantém a conexão viva em redes que derrubam conexões ociosas.
    heartbeat = setInterval(() => {
      for (const client of clients) {
        try { client.write(': ping\n\n'); } catch { clients.delete(client); }
      }
      stopHeartbeatIfEmpty();
    }, 25_000);
    heartbeat.unref?.();
  }

  const remove = () => {
    clients.delete(res);
    stopHeartbeatIfEmpty();
  };
  res.on('close', remove);
  res.on('error', remove);
}

/** Chamado depois de qualquer mudança que a grade de mesas precise refletir. */
export function notifyTableEvents(): void {
  for (const client of clients) {
    try {
      client.write('event: tables\ndata: {}\n\n');
    } catch {
      clients.delete(client);
    }
  }
  stopHeartbeatIfEmpty();
}
