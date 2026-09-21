import nodemailer, { type Transporter } from 'nodemailer';
import { getPool } from './db';

/**
 * Envio de e-mail do Kivo Cloud via SMTP configurado no painel (Configurações).
 *
 * As credenciais ficam em `app_settings` (chaves `smtp_*`) — o mesmo armazenamento chave/valor
 * já usado pelo contato de suporte. A senha nunca volta para a tela; para trocá-la, basta
 * digitar de novo (em branco mantém a atual).
 *
 * O modo de segurança é guardado como texto ('tls' | 'ssl' | 'none') e traduzido para o
 * nodemailer: `ssl` = TLS implícito (porta 465), `tls` = STARTTLS (porta 587, padrão do Gmail),
 * `none` = sem criptografia (só para servidores internos de teste).
 */

export type SmtpSecurity = 'tls' | 'ssl' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS implícito (true) vs. conexão em claro que sobe para TLS (false). */
  secure: boolean;
  /** Exige STARTTLS na porta 587. */
  requireTLS: boolean;
  user: string | null;
  password: string | null;
  fromName: string | null;
  fromEmail: string | null;
}

export interface MailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/** Porta padrão de cada modo de segurança (o Gmail usa 587/TLS e 465/SSL). */
export function defaultPortFor(security: SmtpSecurity): number {
  return security === 'ssl' ? 465 : 587;
}

function normalizeSecurity(v: unknown): SmtpSecurity {
  const s = String(v ?? '').toLowerCase();
  return s === 'ssl' || s === 'none' ? s : 'tls';
}

/** Lê as chaves `smtp_*` de `app_settings`. Devolve null se não houver servidor configurado. */
export async function loadSmtpConfig(): Promise<SmtpConfig | null> {
  const [rows] = await getPool().query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'smtp\\_%'",
  );
  const map = Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );
  const host = String(map.smtp_host ?? '').trim();
  if (!host) return null;
  const security = normalizeSecurity(map.smtp_secure);
  return {
    host,
    port: Number(map.smtp_port) || defaultPortFor(security),
    secure: security === 'ssl',
    requireTLS: security === 'tls',
    user: String(map.smtp_user ?? '').trim() || null,
    password: map.smtp_password ?? null,
    fromName: String(map.smtp_from_name ?? '').trim() || null,
    fromEmail: String(map.smtp_from_email ?? '').trim() || null,
  };
}

export function buildTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
    // Timeouts curtos: o botão "Testar" precisa falhar rápido, não travar a requisição.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

/** Remetente formatado: `"Nome" <email>` quando há nome; senão o e-mail; senão o usuário. */
function formatFrom(cfg: SmtpConfig): string | undefined {
  const email = cfg.fromEmail || cfg.user;
  if (!email) return undefined;
  return cfg.fromName ? `"${cfg.fromName}" <${email}>` : email;
}

/** Envia um e-mail com a configuração SMTP informada (ou a salva, se omitida). */
export async function sendMail(input: MailInput, cfg?: SmtpConfig): Promise<void> {
  const config = cfg ?? (await loadSmtpConfig());
  if (!config) throw new Error('SMTP não configurado.');
  await buildTransport(config).sendMail({ from: formatFrom(config), ...input });
}

/**
 * Testa a conexão e envia um e-mail de verificação. `verify()` valida host/porta/credenciais
 * antes do envio, então o erro devolvido é mais específico do que "falha no envio".
 */
export async function sendTestEmail(to: string, cfg: SmtpConfig): Promise<void> {
  const transporter = buildTransport(cfg);
  await transporter.verify();
  await transporter.sendMail({
    from: formatFrom(cfg),
    to,
    subject: 'Kivo Cloud — teste de SMTP',
    text:
      'Este é um e-mail de teste enviado pelas Configurações do Kivo Cloud.\n\n' +
      'Se você recebeu esta mensagem, o servidor SMTP está configurado corretamente.',
    html:
      '<p>Este é um e-mail de teste enviado pelas <strong>Configurações do Kivo Cloud</strong>.</p>' +
      '<p>Se você recebeu esta mensagem, o servidor SMTP está configurado corretamente.</p>',
  });
}

/** E-mail de recuperação de senha do painel, com o link de redefinição. */
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendMail({
    to,
    subject: 'Kivo Cloud — redefinição de senha',
    text:
      'Recebemos um pedido para redefinir a senha do painel do Kivo Cloud.\n\n' +
      'Abra o link abaixo (válido por 1 hora) para criar uma nova senha:\n' +
      `${resetUrl}\n\n` +
      'Se não foi você, ignore este e-mail — sua senha continua a mesma.',
    html:
      '<p>Recebemos um pedido para redefinir a senha do painel do <strong>Kivo Cloud</strong>.</p>' +
      `<p><a href="${resetUrl}">Criar uma nova senha</a> — link válido por 1 hora.</p>` +
      '<p>Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>',
  });
}

/** Monta uma SmtpConfig a partir do formulário. Senha em branco cai no valor salvo (fallback). */
export function smtpConfigFromBody(body: Record<string, unknown>, fallbackPassword: string | null): SmtpConfig {
  const security = normalizeSecurity(body.smtpSecure);
  const password = String(body.smtpPassword ?? '').trim() || fallbackPassword;
  return {
    host: String(body.smtpHost ?? '').trim(),
    port: Number(body.smtpPort) || defaultPortFor(security),
    secure: security === 'ssl',
    requireTLS: security === 'tls',
    user: String(body.smtpUser ?? '').trim() || null,
    password,
    fromName: String(body.smtpFromName ?? '').trim() || null,
    fromEmail: String(body.smtpFromEmail ?? '').trim() || null,
  };
}
