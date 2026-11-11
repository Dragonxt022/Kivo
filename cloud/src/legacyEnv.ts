/**
 * Compatibilidade de transição Kivo → Kuruk no cloud/.
 *
 * O deploy antigo e os `.env` da VPS ainda podem definir `KIVO_*`. Copiamos
 * cada valor para `KURUK_*` somente quando o nome novo não existe, para que a
 * renomeação não derrube a produção. Deve ser importado depois de
 * `dotenv/config` e antes dos módulos que leem `process.env`.
 */
const LEGACY_ENV_PREFIX = 'KIVO_';
const CURRENT_ENV_PREFIX = 'KURUK_';

for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || !key.startsWith(LEGACY_ENV_PREFIX)) continue;
  const current = CURRENT_ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
  if (process.env[current] === undefined) process.env[current] = value;
}
