/**
 * Reset de fábrica: o lojista sai do período de testes e começa a cadastrar dados reais,
 * sem precisar recriar usuário nem reativar licença.
 *
 * O ponto não óbvio é a ORDEM dos três passos, e ela não é negociável:
 *
 *   1. limpar a NUVEM     → se falhar, aborta sem ter tocado em nada local;
 *   2. backup de segurança → do banco local ainda INTACTO, único desfazer depois daqui;
 *   3. limpar o LOCAL.
 *
 * Invertendo 1 e 3, o reset simplesmente não existiria: `pullAll()` (sync/engine.ts) começa
 * toda rodada com cursor nulo e o `/pull` da nuvem devolve `sync_records` inteiro da empresa
 * sem filtrar máquina de origem, então os dados de teste voltariam no ciclo seguinte — 3
 * minutos depois, ou antes disso se o lojista fechasse uma venda.
 *
 * O backup vem DEPOIS da nuvem, e não antes, por causa de `includeCloudBackups`: o
 * `runBackup()` sobe a cópia para a nuvem, então tirá-lo antes faria a limpeza apagar
 * justamente a rede de segurança recém-criada. Nada se perde nessa ordem — o passo 1 só
 * mexe na réplica na nuvem, o banco local continua completo até o passo 3.
 */
import type { Request } from 'express';
import { audit } from '../audit/service';
import { runBackup } from '../backup/service';
import { resetToFactory, type ResetSummary } from '../database/resetData';
import { resetCompanyData, type CompanyResetResult } from '../sync/client';
import { getLicenseCredentials, validateLicense } from '../license/service';
import { canSaveToCloud } from '../license/plans';
import { SESSION_COOKIE } from '../auth/middleware';
import { createLogger } from '../logger';

const log = createLogger('reset');

export interface FactoryResetInput {
  /** Apaga também os backups guardados na nuvem. Desligado por padrão — ver rota. */
  includeCloudBackups?: boolean;
}

export interface FactoryResetResult {
  /** Backup de segurança tirado antes de apagar qualquer coisa. */
  backupId: number | null;
  backupError: string | null;
  /** `null` quando a empresa não sincroniza (plano sem nuvem ou licença não ativada). */
  cloud: CompanyResetResult | null;
  cloudSkippedReason: string | null;
  tables: ResetSummary[];
  rowsRemoved: number;
}

function sessionTokenFrom(req: Request): string | undefined {
  const match = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : undefined;
}

/**
 * A empresa tem dados na nuvem para limpar? Duas razões legítimas para não ter: nunca
 * ativou licença (não existe empresa lá) ou está num plano sem sincronização. Nesses casos
 * o reset segue só no local — não é falha.
 */
function cloudSkipReason(): string | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) return 'Licença não ativada — não há dados desta empresa na nuvem.';
  if (!canSaveToCloud(validateLicense().plan)) {
    return 'Plano atual não inclui sincronização em nuvem — não há dados desta empresa na nuvem.';
  }
  return null;
}

export async function factoryReset(req: Request, input: FactoryResetInput = {}): Promise<FactoryResetResult> {
  // ─── 1. Nuvem primeiro ───
  // Aqui a falha ABORTA (o erro sobe): zerar o local com a nuvem intacta é pior que não
  // zerar nada, porque devolve os dados de teste sozinho no ciclo seguinte e o lojista não
  // tem como entender o que aconteceu.
  const skipped = cloudSkipReason();
  let cloud: CompanyResetResult | null = null;
  if (!skipped) {
    cloud = await resetCompanyData(input.includeCloudBackups === true);
  }

  // ─── 2. Rede de segurança ───
  // Best-effort de propósito: num disco cheio ou sem permissão de escrita, travar o reset
  // deixaria o lojista sem saída nenhuma. O erro sobe no resultado e a tela mostra.
  let backupId: number | null = null;
  let backupError: string | null = null;
  try {
    backupId = (await runBackup('manual')).id;
  } catch (e) {
    backupError = e instanceof Error ? e.message : String(e);
    log.error('backup de segurança falhou, seguindo mesmo assim:', e);
  }

  // ─── 3. Local ───
  const tables = resetToFactory(sessionTokenFrom(req), req.user?.id);
  const rowsRemoved = tables.reduce((acc, t) => acc + t.removed, 0);

  // Depois do wipe, de propósito: `audit_logs` é uma das tabelas zeradas, então registrar
  // antes seria apagar o próprio registro. Esta vira a primeira linha da auditoria nova.
  audit(req, 'reset_fabrica', 'sistema', 'factory-reset', null, {
    backupId,
    backupError,
    cloud,
    cloudSkippedReason: skipped,
    rowsRemoved,
    tables,
  });

  return { backupId, backupError, cloud, cloudSkippedReason: skipped, tables, rowsRemoved };
}
