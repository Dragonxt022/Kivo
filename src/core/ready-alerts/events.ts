import type { Response } from 'express';
import type { ReadyAlert } from './service';

/**
 * Canal SSE global de "pedido pronto".
 *
 * Fica no cabeçalho de todas as telas (partial ready-alerts). Diferente do poll de 5 s da
 * grade de mesas, este canal empurra o evento na hora em que a cozinha marca o ticket como
 * pronto — inclusive para quem está em outra página, com a aba em segundo plano.
 *
 * O snapshot inicial cobre a navegação entre páginas: ao trocar de tela a conexão anterior
 * fecha e esta reabre; o que ficou pronto nesse intervalo aparece no snapshot em vez de se
 * perder.
 */
export interface ReadyAlertEvent extends ReadyAlert {
  /** Quem marcou como pronto. O próprio aparelho ignora o alerta da sua ação. */
  actorUserId: number | null;
}

const clients = new Set<Response>();
let heartbeat: NodeJS.Timeout | null = null;

function stopHeartbeatIfEmpty(): void {
  if (clients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

export function subscribeReadyAlertEvents(res: Response, snapshot: ReadyAlert[]): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Sem isto, um proxy (ou o próprio navegador, com buffer) pode segurar os eventos.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // 5 s de reconexão: o evento é curto e o custo de reconectar é baixo.
  res.write('retry: 5000\n: conectado\n\n');
  clients.add(res);

  // Depois de entrar na lista: qualquer evento disparado a partir daqui já alcança este
  // cliente. O snapshot é escrito de uma vez (Node não intercala outro write no meio).
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

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

/** Chamado quando um ticket passa para 'pronto'. */
export function broadcastReadyAlert(alert: ReadyAlertEvent): void {
  const payload = `event: ready\ndata: ${JSON.stringify(alert)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
  stopHeartbeatIfEmpty();
}
