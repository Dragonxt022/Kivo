import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';
import { validateLicense } from '../license/service';
import { canUseWebApp } from '../license/plans';
import { drainCommands } from './commands';

/**
 * Conexão persistente com a nuvem para saber, em segundos, que chegou pedido do celular.
 *
 * Webhook não resolveria: esta máquina está atrás de NAT, sem IP público nem certificado — a
 * nuvem não consegue iniciar conexão para cá. Invertendo o sentido (o desktop abre um GET e a
 * nuvem segura a resposta), o mesmo efeito acontece sem nada de infraestrutura na loja.
 *
 * Não usa `EventSource` porque ele não existe no Node e não aceita cabeçalhos personalizados
 * (as credenciais de licença) — o parser de `text/event-stream` aqui é curto o bastante para
 * não justificar uma dependência.
 *
 * Se a conexão cair, o ciclo periódico (`scheduler.ts`) continua cobrindo: este canal encurta
 * a espera, não é o único caminho.
 */

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

let stopped = false;
let delay = RECONNECT_MIN_MS;
let controller: AbortController | null = null;

function onEvent(name: string): void {
  if (name === 'command') {
    void drainCommands();
  } else if (name === 'sync') {
    // Reservado: permite à nuvem pedir um ciclo (ex.: depois de mexer no plano da empresa).
    void import('./scheduler').then((m) => m.scheduleSyncSoon());
  }
}

async function connectOnce(): Promise<void> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) throw new Error('nuvem não configurada');

  controller = new AbortController();
  const res = await fetch(`${base}/api/commands/events`, {
    headers: { ...auth, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  // Conectou: zera o backoff para a próxima queda ser tratada como incidente novo.
  delay = RECONNECT_MIN_MS;
  console.log('[eventos] conectado ao canal da nuvem.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Um evento SSE termina em linha em branco; o resto fica no buffer para o próximo pedaço.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const bloco = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      // Linhas iniciadas por ':' são comentário — é o heartbeat que segura a conexão viva.
      const linha = bloco.split('\n').find((l) => l.startsWith('event:'));
      if (linha) onEvent(linha.slice(6).trim());
    }
  }
  throw new Error('conexão encerrada pelo servidor');
}

/**
 * Espera entre reavaliações de plano. Curta porque a checagem é uma leitura do SQLite local
 * — nada de rede —, e assim ativar a licença já liga o canal em segundos, sem reiniciar.
 */
const SEM_PLANO_MS = 15_000;

async function loop(): Promise<void> {
  while (!stopped) {
    // O plano é reavaliado a CADA volta, não uma vez no boot: o app pode subir antes de a
    // licença ser ativada (primeira instalação) ou a empresa pode migrar para o Diamante
    // com o Kivo aberto. Checar só na largada deixaria o canal desligado até alguém
    // reiniciar o programa — e o sintoma seria "o orçamento do celular não chega".
    if (!canUseWebApp(validateLicense().plan)) {
      await new Promise((r) => setTimeout(r, SEM_PLANO_MS).unref?.());
      continue;
    }
    try {
      // Toda vez que (re)conecta, drena o que entrou enquanto o canal esteve fora.
      void drainCommands();
      await connectOnce();
    } catch (e) {
      if (stopped) return;
      console.log(`[eventos] canal caiu (${(e as Error).message}); tentando em ${Math.round(delay / 1000)}s.`);
    }
    if (stopped) return;
    await new Promise((r) => setTimeout(r, delay).unref?.());
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }
}

/** Chamado no boot, depois dos demais agendadores. Fica ocioso fora do plano Diamante. */
export function startEventChannel(): void {
  stopped = false;
  void loop();
}

export function stopEventChannel(): void {
  stopped = true;
  controller?.abort();
}
