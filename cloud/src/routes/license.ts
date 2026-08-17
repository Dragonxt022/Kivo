import { randomUUID, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, hashLicenseKey, type AuthedRequest } from '../auth';
import { trialValidUntil } from '../plans';

const router = Router();

interface CompanyLicenseRow {
  plan: string | null;
  modules: string[] | string | null;
  valid_until: string | null;
  max_devices: number;
  /** Ver `ensureRecoverySecret`. NULL até a primeira validação pós-migration 0020. */
  recovery_secret: string | null;
  // Perfil da empresa — desce na ativação e preenche as configurações do Kivo local.
  name: string | null;
  legal_name: string | null;
  document: string | null;
  state_registration: string | null;
  email: string | null;
  phone: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
}

/**
 * Segredo de resgate de senha da empresa, criado na primeira vez que ele é pedido.
 *
 * Preguiçoso em vez de gerado na migration porque a migration roda uma vez e empresas
 * nascem o tempo todo (trial, cadastro pelo painel) — colocar a geração aqui cobre todas
 * sem cada caminho de criação ter que lembrar disso.
 *
 * O `UPDATE ... WHERE recovery_secret IS NULL` é o que segura duas validações simultâneas
 * (duas máquinas da mesma loja subindo juntas): a segunda não sobrescreve o segredo da
 * primeira, e o SELECT de volta garante que as duas recebam o MESMO valor. Sobrescrever
 * seria pior que uma corrida qualquer — invalidaria o segredo já guardado no cofre da
 * outra máquina, e o resgate dela pararia de funcionar sem ninguém entender por quê.
 */
async function ensureRecoverySecret(companyUuid: string, current: string | null): Promise<string> {
  if (current) return current;
  const pool = getPool();
  await pool.query('UPDATE companies SET recovery_secret = ? WHERE company_uuid = ? AND recovery_secret IS NULL', [
    randomBytes(32).toString('hex'),
    companyUuid,
  ]);
  const [rows] = await pool.query('SELECT recovery_secret FROM companies WHERE company_uuid = ?', [companyUuid]);
  return (rows as { recovery_secret: string }[])[0].recovery_secret;
}

/**
 * Solicitação de teste grátis (15 dias): cria uma empresa trial automaticamente,
 * sem necessidade de chave prévia. A mesma máquina (machine_id) só pode solicitar
 * uma única vez — o servidor mantém um registro (`trial_registry`) para evitar
 * múltiplos trials no mesmo hardware.
 */
router.post('/request-trial', async (req, res) => {
  const machineId = req.header('X-Kivo-Machine-Id');
  if (!machineId) {
    res.status(400).json({ error: 'Cabeçalho obrigatório: X-Kivo-Machine-Id.' });
    return;
  }

  const pool = getPool();

  // Verifica se esta máquina já usou o teste
  const [existing] = await pool.query('SELECT company_uuid FROM trial_registry WHERE machine_id_hash = ?', [machineId]);
  if ((existing as { company_uuid: string }[]).length > 0) {
    res.status(409).json({ error: 'Esta máquina já utilizou o período de teste gratuito.', alreadyUsed: true });
    return;
  }

  // Gera credenciais para a empresa trial
  const companyUuid = randomUUID();
  const licenseKey = randomBytes(24).toString('hex');
  const validUntil = trialValidUntil();
  // Já sai preenchido aqui, e não na primeira revalidação: quem está em trial não
  // sincroniza (canSaveToCloud exclui trial), então a próxima chamada ao /validate só
  // aconteceria horas depois — e o resgate de senha precisa do segredo já no cofre.
  const recoverySecret = randomBytes(32).toString('hex');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO companies (company_uuid, license_key_hash, name, plan, valid_until, max_devices, recovery_secret)
       VALUES (?, ?, ?, 'trial', ?, 1, ?)`,
      [companyUuid, hashLicenseKey(licenseKey), `Avaliação — ${machineId.slice(0, 8)}`, validUntil, recoverySecret],
    );

    await conn.query(
      'INSERT INTO company_devices (company_uuid, machine_id) VALUES (?, ?)',
      [companyUuid, machineId],
    );

    await conn.query(
      'INSERT INTO trial_registry (machine_id_hash, company_uuid) VALUES (?, ?)',
      [machineId, companyUuid],
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // Contato de suporte global
  const [settingsRows] = await pool.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('support_phone','support_email')",
  );
  const settingsMap = Object.fromEntries(
    (settingsRows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );

  res.json({
    companyUuid,
    licenseKey,
    plan: 'trial',
    validUntil,
    supportPhone: settingsMap.support_phone ?? null,
    supportEmail: settingsMap.support_email ?? null,
    recoverySecret,
    serverTime: new Date().toISOString(),
  });
});

/**
 * Descobre a empresa a partir da própria chave de licença, para o cliente não precisar
 * digitar o UUID na ativação — a chave já é o segredo, o UUID só dizia *onde* conferi-la.
 *
 * Não devolve nada além do UUID e não autentica ninguém: quem tem o UUID ainda precisa da
 * chave para passar por `requireCompanyAuth` em qualquer outra rota. Ainda assim é uma
 * consulta indexada por segredo, então tem freio por IP — sem `express-rate-limit`, que não
 * é dependência da nuvem; o mesmo padrão de mapa em memória já usado nas sessões do admin.
 *
 * `license_key_hash` não tem UNIQUE (migration 0001), então duas empresas com a mesma chave
 * são possíveis na teoria. Nesse caso devolve 409 em vez de escolher uma ao acaso.
 */
const resolveHits = new Map<string, { count: number; resetAt: number }>();
const RESOLVE_WINDOW_MS = 10 * 60_000;
const RESOLVE_MAX = 20;

function resolveThrottled(ip: string): boolean {
  const now = Date.now();
  const hit = resolveHits.get(ip);
  if (!hit || now > hit.resetAt) {
    resolveHits.set(ip, { count: 1, resetAt: now + RESOLVE_WINDOW_MS });
    if (resolveHits.size > 5000) {
      for (const [k, v] of resolveHits) if (now > v.resetAt) resolveHits.delete(k);
    }
    return false;
  }
  hit.count += 1;
  return hit.count > RESOLVE_MAX;
}

router.post('/resolve', async (req, res) => {
  if (resolveThrottled(req.ip ?? 'desconhecido')) {
    res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    return;
  }
  const licenseKey = String(req.body?.licenseKey ?? '').trim();
  if (!licenseKey) {
    res.status(400).json({ error: 'Informe a chave de licença.' });
    return;
  }
  const [rows] = await getPool().query('SELECT company_uuid FROM companies WHERE license_key_hash = ?', [
    hashLicenseKey(licenseKey),
  ]);
  const found = rows as { company_uuid: string }[];
  if (found.length === 0) {
    res.status(404).json({ error: 'Chave de licença não encontrada.' });
    return;
  }
  if (found.length > 1) {
    res.status(409).json({ error: 'Esta chave está em mais de uma empresa. Contate o suporte.' });
    return;
  }
  res.json({ companyUuid: found[0].company_uuid });
});

/**
 * Serve tanto a ativação inicial quanto a revalidação periódica (Kivo local). Registra
 * o dispositivo (machine_id) na primeira vez que o vê, dentro do limite `max_devices`
 * da empresa; uma máquina já conhecida nunca é recontada contra o limite — só uma
 * máquina NOVA é que compara. Um dispositivo removido pelo suporte (`removed_at`) é
 * bloqueado de forma imediata e específica (`device_revoked`), diferente de só não
 * ter mais vaga (`device_limit_exceeded`).
 */
router.get('/validate', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const machineId = req.header('X-Kivo-Machine-Id');
  if (!machineId) {
    res.status(400).json({ error: 'Cabeçalho obrigatório: X-Kivo-Machine-Id.' });
    return;
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [companyRows] = await conn.query(
      `SELECT plan, modules, valid_until, max_devices, recovery_secret,
              name, legal_name, document, state_registration, email, phone,
              zip, street, number, complement, district, city, state
       FROM companies WHERE company_uuid = ? FOR UPDATE`,
      [req.companyUuid],
    );
    const company = (companyRows as CompanyLicenseRow[])[0];
    if (!company) {
      await conn.rollback();
      res.status(404).json({ error: 'Empresa não encontrada.' });
      return;
    }

    const [deviceRows] = await conn.query(
      'SELECT id, removed_at FROM company_devices WHERE company_uuid = ? AND machine_id = ?',
      [req.companyUuid, machineId],
    );
    const device = (deviceRows as { id: number; removed_at: string | null }[])[0];

    if (device) {
      if (device.removed_at) {
        await conn.rollback();
        res.status(403).json({ error: 'device_revoked' });
        return;
      }
      await conn.query('UPDATE company_devices SET last_seen_at = NOW(3) WHERE id = ?', [device.id]);
    } else {
      const [countRows] = await conn.query(
        'SELECT COUNT(*) AS total FROM company_devices WHERE company_uuid = ? AND removed_at IS NULL',
        [req.companyUuid],
      );
      const total = (countRows as { total: number }[])[0].total;
      if (total >= company.max_devices) {
        await conn.rollback();
        res.status(403).json({ error: 'device_limit_exceeded', maxDevices: company.max_devices });
        return;
      }
      await conn.query('INSERT INTO company_devices (company_uuid, machine_id) VALUES (?, ?)', [req.companyUuid, machineId]);
    }

    await conn.commit();

    // `modules` NULL = nunca configurado no cloud/ (sem restrição ainda, fail-open) —
    // diferente de `[]` (configurado explicitamente como "nenhum módulo"), que bloqueia tudo.
    const modules = company.modules == null ? null : typeof company.modules === 'string' ? JSON.parse(company.modules) : company.modules;

    // Contato de suporte é global (do fornecedor Kivo), não por empresa — mesmo valor para todas.
    const [settingsRows] = await pool.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('support_phone','support_email')",
    );
    const settingsMap = Object.fromEntries(
      (settingsRows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
    );

    // Desce em TODA validação (não só na ativação) de propósito: o resgate de senha tem
    // que funcionar offline, então o segredo precisa já estar no cofre da máquina quando a
    // senha for perdida. Instalação antiga o recebe na próxima revalidação periódica.
    const recoverySecret = await ensureRecoverySecret(req.companyUuid!, company.recovery_secret);

    res.json({
      plan: company.plan,
      modules,
      validUntil: company.valid_until,
      supportPhone: settingsMap.support_phone ?? null,
      supportEmail: settingsMap.support_email ?? null,
      recoverySecret,
      // Perfil da empresa cadastrado no painel — o Kivo local usa para preencher as
      // configurações (nome/documento/endereço do cupom) na ativação, só se vazias.
      company: {
        name: company.name,
        legalName: company.legal_name,
        document: company.document,
        stateRegistration: company.state_registration,
        email: company.email,
        phone: company.phone,
        zip: company.zip,
        street: company.street,
        number: company.number,
        complement: company.complement,
        district: company.district,
        city: company.city,
        state: company.state,
      },
      // Alimenta o watermark anti-retrocesso de relógio no Kivo local — o cliente não
      // deve confiar no próprio relógio pra isso, só no horário que o servidor confirma.
      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

/**
 * Perfil do negócio respondido no assistente de boas-vindas do Kivo local (migration 0021).
 *
 * Só preenche o que veio: o app manda os três campos juntos, mas uma versão futura que
 * mandar só um não pode zerar os outros dois. `name` cai em `companies.name` (nome
 * fantasia) e só sobrescreve se vier preenchido — o cadastro feito no painel do cloud vale
 * mais que um campo em branco vindo do app.
 *
 * Idempotente por natureza: reabrir o assistente e salvar de novo apenas reescreve.
 */
const FAIXAS_FUNCIONARIOS = new Set(['1-5', '6-50', '51-100', '100+']);

router.put('/business-profile', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const { name, businessType, employeeRange } = (req.body ?? {}) as {
    name?: unknown;
    businessType?: unknown;
    employeeRange?: unknown;
  };

  const nome = typeof name === 'string' ? name.trim().slice(0, 255) : '';
  const ramo = typeof businessType === 'string' ? businessType.trim().slice(0, 40) : '';
  const faixa = typeof employeeRange === 'string' ? employeeRange.trim() : '';
  // Faixa validada contra a lista fechada: é dado de pesquisa, e aceitar texto livre aqui
  // transformaria o relatório de porte numa coluna impossível de agrupar.
  const faixaValida = FAIXAS_FUNCIONARIOS.has(faixa) ? faixa : null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (nome) {
    sets.push('name = ?');
    params.push(nome);
  }
  if (ramo) {
    sets.push('business_type = ?');
    params.push(ramo);
  }
  if (faixaValida) {
    sets.push('employee_range = ?');
    params.push(faixaValida);
  }
  if (!sets.length) {
    res.status(400).json({ error: 'Nada a gravar: envie name, businessType ou employeeRange.' });
    return;
  }
  sets.push('business_profile_at = NOW(3)');
  params.push(req.companyUuid);

  await getPool().query(`UPDATE companies SET ${sets.join(', ')} WHERE company_uuid = ?`, params);
  res.json({ ok: true, name: nome || null, businessType: ramo || null, employeeRange: faixaValida });
});

export default router;
