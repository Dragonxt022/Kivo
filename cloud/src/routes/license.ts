import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

const router = Router();

interface CompanyLicenseRow {
  plan: string | null;
  modules: string[] | string | null;
  valid_until: string | null;
  max_devices: number;
  // Perfil da empresa — desce na ativação e preenche as configurações do Katsu local.
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
 * Serve tanto a ativação inicial quanto a revalidação periódica (Katsu local). Registra
 * o dispositivo (machine_id) na primeira vez que o vê, dentro do limite `max_devices`
 * da empresa; uma máquina já conhecida nunca é recontada contra o limite — só uma
 * máquina NOVA é que compara. Um dispositivo removido pelo suporte (`removed_at`) é
 * bloqueado de forma imediata e específica (`device_revoked`), diferente de só não
 * ter mais vaga (`device_limit_exceeded`).
 */
router.get('/validate', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const machineId = req.header('X-Katsu-Machine-Id');
  if (!machineId) {
    res.status(400).json({ error: 'Cabeçalho obrigatório: X-Katsu-Machine-Id.' });
    return;
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [companyRows] = await conn.query(
      `SELECT plan, modules, valid_until, max_devices,
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

    // Contato de suporte é global (do fornecedor Katsu), não por empresa — mesmo valor para todas.
    const [settingsRows] = await pool.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('support_phone','support_email')",
    );
    const settingsMap = Object.fromEntries(
      (settingsRows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
    );

    res.json({
      plan: company.plan,
      modules,
      validUntil: company.valid_until,
      supportPhone: settingsMap.support_phone ?? null,
      supportEmail: settingsMap.support_email ?? null,
      // Perfil da empresa cadastrado no painel — o Katsu local usa para preencher as
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
      // Alimenta o watermark anti-retrocesso de relógio no Katsu local — o cliente não
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

export default router;
