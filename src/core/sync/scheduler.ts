import { settingsRepository } from '../repositories/SettingsRepository';
import { systemRequest } from '../auth/systemContext';
import { runSync } from './engine';
import { drainCommands } from './commands';

/**
 * Ciclo periódico de sincronização.
 *
 * Até aqui o sync só acontecia por clique em "Sincronizar agora" (`POST /api/sync/run`, com
 * permissão `sync.run`) — o comentário na rota registrava que o agendamento ficaria para
 * depois. Passou a ser obrigatório com o Kivo Web: o painel no celular lê o que a nuvem tem,
 * então sem ciclo automático o dono da loja vê número velho achando que é de agora.
 *
 * `runSync` já se protege sozinho — devolve `{ skipped: true }` quando o plano não inclui
 * nuvem —, então não há checagem de plano duplicada aqui.
 */

const DEFAULT_MINUTES = 3;
/** Janela do agrupamento pós-venda: fechar 20 vendas seguidas dispara UM sync, não 20. */
const DEBOUNCE_MS = 20_000;

let timer: NodeJS.Timeout | null = null;
let debounce: NodeJS.Timeout | null = null;
let running = false;

function intervalMinutes(): number {
  const raw = settingsRepository.get('sync.intervalo_minutos');
  if (raw == null || raw === '') return DEFAULT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MINUTES;
  return n;
}

/**
 * Uma rodada por vez. Sem esta trava, uma sincronização lenta (catálogo grande, rede ruim)
 * ainda estaria no ar quando a próxima disparasse, e as duas empurrariam as mesmas linhas
 * sujas — `markSynced` da primeira apagaria o estado que a segunda já tinha lido.
 */
async function tick(motivo: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runSync(systemRequest());
    if (!result.skipped && (result.pushed || result.pulled)) {
      console.log(`[sync:${motivo}] enviados=${result.pushed} recebidos=${result.pulled}`);
    }
    // Rede de segurança do canal de eventos: se ele estiver caído, os pedidos feitos no
    // celular ainda são aplicados aqui, com a latência do ciclo em vez de segundos.
    if (!result.skipped) await drainCommands();
  } catch (e) {
    // Rede fora do ar é o caso comum e esperado — o próximo ciclo tenta de novo.
    console.error(`[sync:${motivo}] falhou:`, (e as Error).message);
  } finally {
    running = false;
  }
}

/** Chamado no boot, junto dos demais agendadores (core/server.ts). */
export function startSyncScheduler(): void {
  const minutes = intervalMinutes();
  if (minutes <= 0) {
    console.log('[sync] ciclo automático desligado (sync.intervalo_minutos = 0).');
    return;
  }
  timer = setInterval(() => void tick('periodico'), minutes * 60_000);
  // unref: um timer pendente não pode segurar o processo vivo no encerramento.
  timer.unref();
  console.log(`[sync] ciclo automático a cada ${minutes} min.`);
}

/** Usado ao mudar o intervalo em Configurações, para valer sem reiniciar o app. */
export function restartSyncScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  startSyncScheduler();
}

/**
 * Gatilho por evento: a venda acabou de ser fechada e a nuvem deveria saber logo, sem esperar
 * o ciclo inteiro. Nunca `await` no caminho do PDV — o caixa não pode ficar esperando a rede
 * (mesmo padrão do sync pós-cardápio em commercial/productsRoutes.ts).
 */
export function scheduleSyncSoon(): void {
  if (intervalMinutes() <= 0) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void tick('pos-venda');
  }, DEBOUNCE_MS);
  debounce.unref();
}
