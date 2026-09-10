import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { isLoopback } from '../auth/quickLogin';
import { audit } from '../audit/service';
import {
  getUpdateState,
  verificarAtualizacao,
  baixarAtualizacao,
  instalarAtualizacao,
} from './index';
import { createLogger } from '../logger';
import { settingsRepository } from '../repositories/SettingsRepository';
import { LICENSED_VERSION_KEY } from '../license/service';

const log = createLogger('updater');

const router = Router();

/** Compara versões "x.y.z" (só os três primeiros números). */
function cmpVersao(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * A tela de Configurações e o sino do cabeçalho leem daqui. É uma leitura de memória
 * (nenhum I/O), então pode ser consultada de poucos em poucos segundos enquanto uma
 * barra de progresso estiver na tela. Inclui a versão mínima exigida pelo suporte.
 */
router.get('/status', requirePermission('settings.view'), (_req, res) => {
  const estado = getUpdateState();
  const exigida = (settingsRepository.get(LICENSED_VERSION_KEY) ?? '').trim();
  const atual = estado.versaoAtual;
  const obrigatoria = !!exigida && /^\d/.test(atual) && cmpVersao(atual, exigida) < 0;
  res.json({ ...estado, versaoExigida: exigida || null, atualizacaoObrigatoria: obrigatoria });
});

router.post('/check', requirePermission('settings.edit'), async (_req, res) => {
  const r = await verificarAtualizacao();
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json(getUpdateState());
});

router.post('/download', requirePermission('settings.edit'), async (_req, res) => {
  // Responde assim que o download COMEÇA, não quando termina: um pacote de 100 MB
  // estouraria qualquer timeout de fetch. O andamento sai pelo `GET /status`.
  const r = await baixarAtualizacao();
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json(getUpdateState());
});

/**
 * Instalar fecha o Kivo desta máquina. Por isso só vale do próprio computador: quem
 * abriu a tela pelo celular na rede local (ver "Acesso pela rede local") derrubaria o
 * PDV do caixa no meio de uma venda sem nem estar perto dele. Mesma régua do login
 * rápido em core/auth/quickLogin.ts.
 */
router.post('/install', requirePermission('settings.edit'), (req, res) => {
  if (!isLoopback(req)) {
    res.status(403).json({
      error: 'A instalação precisa ser feita no próprio computador onde o Kivo está instalado.',
    });
    return;
  }
  const estado = getUpdateState();
  if (estado.status !== 'baixado') {
    res.status(400).json({ error: 'A atualização ainda não terminou de baixar.' });
    return;
  }
  audit(req, 'instalar_atualizacao', 'app', estado.versaoDisponivel ?? undefined, { versao: estado.versaoAtual }, { versao: estado.versaoDisponivel });
  res.json({ ok: true, versao: estado.versaoDisponivel });
  // Depois da resposta sair do fio: `quitAndInstall` mata o processo, e fazer isso antes
  // deixaria a tela pendurada num fetch que nunca responde — sem nenhuma pista do que houve.
  setTimeout(() => {
    const r = instalarAtualizacao();
    if (!r.ok) log.error('falha ao instalar', r.error);
  }, 500);
});

export default router;
