import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Router } from 'express';
import QRCode from 'qrcode';
import { getSqlite } from '../database/connection';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { validateBody } from '../../shared/validateBody';
import { setSettingSchema } from '../../shared/schemas';
import { getCloudServerUrl } from './cloud';
import { setSecret, deleteSecret } from '../secrets/service';
import { BRAVE_API_KEY_SECRET, getWebImageConfig, searchWebImages } from '../catalog/webImageSearch';
import { getMachinePrefs, setMachinePrefs } from './machinePrefs';
import { saveCompanyLogo, deleteCompanyLogoFile, LOGO_SETTING_KEY } from './companyLogo';
import { getLicenseCredentials } from '../license/service';
import { factoryReset } from '../reset/service';
import { settingsRepository } from '../repositories/SettingsRepository';
import { restartSyncScheduler } from '../sync/scheduler';
import { ICON_PACK_SETTING, getSelectedPackId, iconPackCover, installIconPack, saveIconPackCover, invalidateIconPackCache, listIconPacks } from '../icons/service';
import { cloudAuthHeaders, cloudBaseUrl } from '../catalog/submissionQueue';
import { createLogger } from '../logger';

const log = createLogger('reset');

const router = Router();

/** Nomes de adaptador que não são a rede física da loja (VMware/VirtualBox/Hyper-V/WSL,
 * Docker, VPNs, Bluetooth, loopback…). Filtrados da lista de endereços de acesso. */
const VIRTUAL_IFACE_RE =
  /(virtual|vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth|tailscale|zerotier|hamachi|radmin|wireguard|openvpn|\btap\b|\btun\b|npcap|bridge)/i;

/** Faixas privadas de LAN (RFC 1918). 169.254.x (APIPA) fica de fora: é o endereço que
 * a máquina dá a si mesma quando o cabo/Wi-Fi não conseguiu DHCP — não alcança ninguém. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

/** Ordem de exibição: 192.168.x (roteador/Wi-Fi doméstico) → 10.x → 172.16-31.x → resto. */
function rankIPv4(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p[0] === 192 && p[1] === 168) return 0;
  if (p[0] === 10) return 1;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 2;
  return 3;
}

router.get('/', requirePermission('settings.view'), (_req, res) => {
  const rows = getSqlite()
    .prepare('SELECT key, value, updated_at FROM settings WHERE deleted_at IS NULL ORDER BY key')
    .all();
  res.json(rows);
});

/** Endereços IPv4 desta máquina na rede local — para a tela de Configurações
 * mostrar ao admin como o celular do garçom/tablet da cozinha alcançam o Kivo.
 * O QR de cada endereço é gerado aqui (server-side, lib `qrcode` pura-JS, sem
 * dependência nativa nem CDN) para não precisar vendorizar mais um bundle
 * client-side — mesmo espírito 100% offline do resto do app. */
router.get('/network-info', requirePermission('settings.view'), async (req, res) => {
  const port = Number(process.env.KIVO_PORT ?? 3123);
  const candidatos: { iface: string; address: string }[] = [];
  for (const [nome, addrs] of Object.entries(os.networkInterfaces())) {
    // Adaptadores virtuais (VMware, VirtualBox, Hyper-V/WSL, Docker, VPNs…) aparecem como
    // IPv4 não-interno e enchiam a tela com endereços que ninguém alcança. Ignoramos pelo
    // nome da interface.
    if (VIRTUAL_IFACE_RE.test(nome)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!isPrivateIPv4(addr.address)) continue;
      candidatos.push({ iface: nome, address: addr.address });
    }
  }
  // Rede incomum (IP público, faixa não coberta): melhor mostrar todos do que nenhum —
  // exceto 169.254.x, que é o endereço de emergência sem DHCP e não alcança ninguém.
  if (!candidatos.length) {
    for (const [nome, addrs] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_IFACE_RE.test(nome)) continue;
      for (const addr of addrs ?? []) {
        if (addr.family !== 'IPv4' || addr.internal || addr.address.startsWith('169.254.')) continue;
        candidatos.push({ iface: nome, address: addr.address });
      }
    }
  }
  // 192.168.x costuma ser o roteador/Wi-Fi da loja; ordena para o endereço mais provável
  // aparecer primeiro, e sem repetir o mesmo IP de duas interfaces.
  const vistos = new Set<string>();
  const rawUrls: string[] = [];
  for (const c of candidatos.sort((a, b) => rankIPv4(a.address) - rankIPv4(b.address) || a.iface.localeCompare(b.iface))) {
    if (vistos.has(c.address)) continue;
    vistos.add(c.address);
    rawUrls.push(`http://${c.address}:${port}`);
  }
  const urls = await Promise.all(
    rawUrls.map(async (url) => ({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 160 }) })),
  );
  // Em que host o servidor REALMENTE está escutando agora (electron/main.ts grava ao
  // escutar e atualiza no rebind a quente). A tela compara com a chave salva para dizer
  // "já vale" ou "ativando…" em vez de deixar o lojista adivinhando por que o celular
  // não abre.
  const lanAtivo = typeof req.app.locals.lanAtivo === 'boolean' ? (req.app.locals.lanAtivo as boolean) : null;
  res.json({ urls, port, lanAtivo });
});

/** Link público do cardápio online (Fase 6) + QR — monta a partir do company_uuid da
 * licença ativada e da URL do cloud/ configurada; sem licença/cloud configurado, não
 * há link possível (o app funciona 100% offline até aqui). */
router.get('/cardapio-info', requirePermission('settings.view'), async (_req, res) => {
  const { companyUuid } = getLicenseCredentials();
  const cloudUrl = getCloudServerUrl();
  if (!companyUuid || !cloudUrl) {
    res.json({ url: null, qr: null });
    return;
  }
  const url = `${cloudUrl.replace(/\/$/, '')}/cardapio/${companyUuid}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 200 });
  res.json({ url, qr });
});

/**
 * Preferências desta máquina (modo leve). Ficam fora da tabela `settings` porque ela
 * sincroniza para as outras máquinas da empresa — ver core/config/machinePrefs.ts.
 *
 * Precisam vir ANTES do `PUT /:key` abaixo, que é curinga e engoliria `/machine-prefs`.
 * Leitura exige só `settings.view`; escrita, `settings.edit` — mesma régua das demais.
 */
router.get('/machine-prefs', requirePermission('settings.view'), (_req, res) => {
  res.json(getMachinePrefs());
});

router.put('/machine-prefs', requirePermission('settings.edit'), (req, res) => {
  const { modoLeve } = req.body ?? {};
  if (typeof modoLeve !== 'boolean') {
    res.status(400).json({ error: 'Informe modoLeve (true/false).' });
    return;
  }
  const before = getMachinePrefs();
  // `modoLeveDetectado` fecha a porta da detecção automática: depois de uma escolha manual,
  // o app nunca mais reverte o que o usuário decidiu.
  const after = setMachinePrefs({ modoLeve, modoLeveDetectado: true });
  // As views leem `modoLeve` de app.locals para estampar `data-lite` no <html> já no primeiro
  // byte da resposta (sem piscar). Sem atualizar aqui, só valeria depois de reiniciar.
  req.app.locals.modoLeve = after.modoLeve;
  audit(req, 'editar', 'machine-prefs', 'modoLeve', before, after);
  res.json(after);
});

/**
 * Logo da empresa. Rota própria em vez de mandar a imagem pelo `PUT /:key` genérico
 * porque aqui há validação de formato, gravação de arquivo e limpeza da logo anterior —
 * nada disso cabe num setter de string. Precisa vir ANTES do `PUT /:key`, que é curinga.
 */
router.put('/company-logo', requirePermission('settings.edit'), (req, res) => {
  const { imageBase64 } = req.body ?? {};
  if (!imageBase64) {
    res.status(400).json({ error: 'Envie a imagem em imageBase64.' });
    return;
  }
  const saved = saveCompanyLogo(String(imageBase64));
  if (!saved.ok) {
    res.status(400).json({ error: saved.error });
    return;
  }
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(LOGO_SETTING_KEY) as
    | { key: string; value: string | null }
    | undefined;
  db.prepare(
    `INSERT INTO settings (key, value, uuid) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`,
  ).run(LOGO_SETTING_KEY, saved.url, randomUUID());
  // Só depois de a nova estar gravada: se a escrita acima falhasse, apagar antes deixaria
  // a loja sem logo nenhuma.
  deleteCompanyLogoFile(before?.value);
  audit(req, 'editar', 'setting', LOGO_SETTING_KEY, before ?? null, { key: LOGO_SETTING_KEY, value: saved.url });
  res.json({ url: saved.url });
});

router.delete('/company-logo', requirePermission('settings.edit'), (req, res) => {
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(LOGO_SETTING_KEY) as
    | { key: string; value: string | null }
    | undefined;
  db.prepare(`UPDATE settings SET value = NULL, updated_at = datetime('now') WHERE key = ?`).run(LOGO_SETTING_KEY);
  deleteCompanyLogoFile(before?.value);
  audit(req, 'excluir', 'setting', LOGO_SETTING_KEY, before ?? null, null);
  res.json({ ok: true });
});

/**
 * Configuração da busca externa de imagens (Brave Search) — sugestões ao cadastrar produto.
 *
 * A API Key NÃO vai para a tabela `settings`: lá ela sincronizaria entre máquinas e seria
 * devolvida por `GET /api/settings` a qualquer usuário com `settings.view`. Fica no cofre
 * local (core/secrets). A tela só vê se está configurada, nunca o valor.
 */
router.get('/image-search-config', requirePermission('settings.view'), (_req, res) => {
  const cfg = getWebImageConfig();
  res.json({ configured: !!cfg, source: cfg?.source ?? null });
});

router.put('/image-search-config', requirePermission('settings.edit'), (req, res) => {
  const { apiKey } = req.body ?? {};
  const before = { configured: !!getWebImageConfig() };
  // Campo ausente = não mexe. `apiKey: ''` remove a chave do COFRE (se houver padrão por
  // variável de ambiente, a busca continua ligada — ver getWebImageConfig).
  if (apiKey !== undefined) {
    if (apiKey === null || String(apiKey).trim() === '') deleteSecret(BRAVE_API_KEY_SECRET);
    else setSecret(BRAVE_API_KEY_SECRET, String(apiKey).trim());
  }
  const afterCfg = getWebImageConfig();
  const after = { configured: !!afterCfg, source: afterCfg?.source ?? null };
  audit(req, 'editar', 'setting', 'image-search-config', before, after);
  res.json(after);
});

/**
 * Testa a configuração chamando a Brave com um termo de exemplo. Devolve quantas imagens
 * voltaram ou o motivo da falha — sem isso, uma chave errada só apareceria como "nenhuma
 * sugestão" no cadastro, sem dizer o porquê.
 */
router.post('/image-search-config/test', requirePermission('settings.edit'), async (req, res) => {
  if (!getWebImageConfig()) {
    res.json({ tested: false, error: 'Configure a API Key primeiro.' });
    return;
  }
  const q = String(req.body?.q ?? '').trim() || 'refrigerante lata';
  try {
    const results = await searchWebImages(q, 6);
    // `tested` (e não `ok`): o envelope colapsa `{ ok: true, count }` em só o número,
    // perdendo o campo — ver shared/responseEnvelope.ts.
    res.json({ tested: true, count: results.length });
  } catch (e) {
    res.json({ tested: false, error: e instanceof Error ? e.message : 'Falha ao consultar a Brave.' });
  }
});

/**
 * Reset de fábrica (zona de perigo). Também precisa vir antes do `PUT /:key` — que é
 * curinga só para PUT, mas manter os dois juntos evita a próxima armadilha.
 *
 * A confirmação por texto não é teatro: é a única barreira entre um clique errado e a
 * perda de todo o histórico da loja, e um `confirm()` comum já foi clicado no automático
 * mil vezes por qualquer usuário. Conferida no servidor, e não só na tela, porque a
 * chamada é uma rota HTTP como qualquer outra.
 */
const RESET_CONFIRMATION = 'RESETAR';

/**
 * Erro da nuvem em uma linha legível. Quando o servidor responde uma página de erro em vez
 * de JSON (proxy fora do ar, rota ainda não publicada), a mensagem crua é um documento HTML
 * inteiro — que ia parar dentro do balão de erro da tela, ilegível para o lojista.
 */
function resumirErro(e: unknown): string {
  const bruto = e instanceof Error ? e.message : String(e);
  const semHtml = bruto.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return semHtml.length > 160 ? `${semHtml.slice(0, 157)}…` : semHtml;
}

router.post('/factory-reset', requirePermission('settings.edit'), async (req, res) => {
  const { confirmacao, includeCloudBackups } = req.body ?? {};
  if (String(confirmacao ?? '').trim().toUpperCase() !== RESET_CONFIRMATION) {
    res.status(400).json({ error: `Digite ${RESET_CONFIRMATION} para confirmar.` });
    return;
  }
  try {
    res.json(await factoryReset(req, { includeCloudBackups: includeCloudBackups === true }));
  } catch (e) {
    // Falha na etapa da nuvem chega aqui com o banco local ainda INTACTO (ver a ordem em
    // core/reset/service.ts) — daí a mensagem poder afirmar que nada foi apagado.
    log.error('falhou:', e);
    res.status(502).json({
      error:
        'Não deu para limpar os dados na nuvem, então nada foi apagado — seus dados continuam ' +
        `como estavam. Tente de novo daqui a pouco. Detalhe: ${resumirErro(e)}`,
    });
  }
});

/**
 * Pacote de ícones: lista os disponíveis nesta instalação e troca o escolhido. A escolha é
 * uma chave de `settings` (sincroniza entre as máquinas da empresa). Rota própria porque a
 * troca precisa invalidar o cache de ícones do processo — o `PUT /:key` genérico não tem
 * gancho para isso. Precisa vir ANTES do curinga `PUT /:key`.
 */
router.get('/icon-packs', requirePermission('settings.view'), (_req, res) => {
  const { packs, ignorados } = listIconPacks();
  res.json({
    packs: packs.map((p) => ({
      id: p.id,
      name: p.name,
      icons: p.icons,
      // URL da capa para o card; null = card mostra o placeholder (ex.: o pacote padrão).
      cover: p.hasCover ? `/api/settings/icon-pack-cover/${encodeURIComponent(p.id)}` : null,
    })),
    ignorados,
    current: getSelectedPackId(),
  });
});

/** Capa do pacote (capa.jpg/png/webp/svg) para o card. 404 = o card cai no placeholder. */
router.get('/icon-pack-cover/:id', requirePermission('settings.view'), (req, res) => {
  const cover = iconPackCover(String(req.params.id));
  if (!cover) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(cover.path, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

router.put('/icon-pack', requirePermission('settings.edit'), (req, res) => {
  const id = String(req.body?.id ?? '').trim();
  const { packs } = listIconPacks();
  if (id && !packs.some((p) => p.id === id)) {
    res.status(400).json({ error: 'Pacote de ícones não encontrado nesta instalação.' });
    return;
  }
  const before = settingsRepository.get(ICON_PACK_SETTING);
  settingsRepository.set(ICON_PACK_SETTING, id);
  invalidateIconPackCache();
  audit(req, 'editar', 'setting', ICON_PACK_SETTING, before ?? null, id);
  res.json({ id });
});

/**
 * Loja de temas: o desktop fala com o cloud pelo SERVIDOR (não pelo navegador — a CSP só
 * deixa `connect-src 'self'`). O servidor local já tem as credenciais de licença, então
 * estas rotas são um proxy fino: listar, servir a capa e baixar+instalar o pacote.
 *
 * O install baixa o pack, grava em storage/peck-icon/<slug>/ e JÁ ATIVA o tema — o cliente
 * só precisa recarregar a página para os ícones novos aparecerem.
 */
router.get('/theme-store', requirePermission('settings.view'), async (_req, res) => {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    res.json({ configured: false, themes: [] });
    return;
  }
  try {
    const r = await fetch(`${base}/api/themes`, { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      res.status(502).json({ configured: true, themes: [], error: `A nuvem respondeu ${r.status}.` });
      return;
    }
    const data = (await r.json()) as { themes: { id: number; cover: string | null }[] };
    // A capa vem apontando para a nuvem; reescreve para o proxy local.
    const themes = (data.themes ?? []).map((t) => ({
      ...t,
      cover: t.cover ? `/api/settings/theme-store/${t.id}/cover` : null,
    }));
    res.json({ configured: true, themes });
  } catch {
    res.status(502).json({ configured: true, themes: [], error: 'Não foi possível falar com a nuvem.' });
  }
});

router.get('/theme-store/:id/cover', requirePermission('settings.view'), async (req, res) => {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    res.status(404).end();
    return;
  }
  try {
    const r = await fetch(`${base}/api/themes/${encodeURIComponent(String(req.params.id))}/cover`, {
      headers: auth,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
});

router.post('/theme-store/install', requirePermission('settings.edit'), async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Tema inválido.' });
    return;
  }
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    res.status(400).json({ error: 'A nuvem não está configurada nesta instalação.' });
    return;
  }
  try {
    const r = await fetch(`${base}/api/themes/${id}/pack`, { headers: auth, signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      res.status(r.status === 403 ? 403 : 502).json({ error: d.error || `A nuvem respondeu ${r.status}.` });
      return;
    }
    const pack = (await r.json()) as {
      slug: string;
      name: string;
      files: Record<string, string>;
      cover?: { mime: string; base64: string } | null;
    };
    const count = installIconPack(pack.slug, pack.files ?? {});
    // A capa não vem no pack: grava à parte, senão o card do pacote instalado fica sem imagem.
    if (pack.cover?.base64) saveIconPackCover(pack.slug, pack.cover.mime, pack.cover.base64);
    const before = settingsRepository.get(ICON_PACK_SETTING);
    settingsRepository.set(ICON_PACK_SETTING, pack.slug);
    invalidateIconPackCache();
    audit(req, 'editar', 'setting', ICON_PACK_SETTING, before ?? null, pack.slug);
    res.json({ slug: pack.slug, name: pack.name, icons: count });
  } catch {
    res.status(502).json({ error: 'Falha ao baixar o tema da nuvem.' });
  }
});

router.put('/:key', requirePermission('settings.edit'), validateBody(setSettingSchema), (req, res) => {
  const key = String(req.params.key);
  const { value } = req.body;
  const db = getSqlite();
  const before = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key);
  db.prepare(
    `INSERT INTO settings (key, value, uuid) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`,
  ).run(key, value != null ? String(value) : null, randomUUID());
  const after = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key);
  audit(req, 'editar', 'setting', key, before ?? null, after);
  res.json(after);
  // Efeitos que valem sem reiniciar o app, aplicados DEPOIS de a resposta sair do fio:
  // - acesso pela rede local: troca o host do servidor em execução (o Electron registra
  //   `rebindLan`; em dev/testes não existe e o servidor já escuta em todas as interfaces).
  //   Ao desligar, quem está conectado pela rede perde a conexão — comportamento esperado.
  // - intervalo de sync: remonta o ciclo automático com o novo valor.
  if (key === 'rede.acesso_local') {
    const rebind = req.app.locals.rebindLan as ((ligado: boolean) => Promise<boolean>) | undefined;
    if (rebind) res.on('finish', () => void rebind(value === '1'));
  } else if (key === 'sync.intervalo_minutos') {
    restartSyncScheduler();
  }
});

export default router;
