/**
 * Diagnóstico "o que falta para emitir".
 *
 * A ideia é que o lojista nunca fique travado sem saber o motivo: cada pendência vira uma
 * linha com o que falta, por que importa e onde resolver. É o que substitui a alternativa
 * ruim — descobrir o problema só na hora da rejeição da SEFAZ, no meio de uma venda.
 */
import { getSqlite } from '../../../core/database/connection';
import { validateCNPJ } from '../../../shared/documents';
import { getConfig, getEmpresa, hasCsc, hasProviderToken } from './config';
import { currentCertificate } from './certificate';

/** Abaixo disso, avisar que o certificado está perto de vencer. */
const CERT_WARN_DAYS = 30;

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  actionLabel?: string;
  actionHref?: string;
  /** Passo do assistente que resolve esta pendência. */
  step?: number;
}

export interface Readiness {
  /** Nenhum `fail` — dá para tentar emitir. `warn` não bloqueia. */
  ready: boolean;
  ambiente: 1 | 2;
  podeAtivarProducao: boolean;
  checks: ReadinessCheck[];
  produtosSemNcm: number;
  produtosTotal: number;
}

/**
 * Conta produtos que virariam item de nota sem NCM.
 *
 * O conjunto é definido por uma pergunta só: este produto pode virar uma linha de
 * `sale_items`? É de lá que a nota tira o item, e é no `product_id` daquela linha que
 * o NCM é buscado.
 *
 * Fora da conta:
 * - `servico` — serviço é NFS-e municipal, não sai em NFC-e;
 * - o produto com variações (tipo `variante` SEM pai) — é linha de estrutura, agrupa as
 *   filhas e nunca é vendido; a venda registra a variação escolhida.
 *
 * Dentro da conta, por venderem direto:
 * - as variantes FILHAS — "camiseta azul M" é o que sai na nota, então é ela que precisa
 *   do NCM. Elas são muitas por natureza, e é para isso que a tela de dados fiscais tem
 *   preenchimento em lote: seleciona a grade inteira e aplica o mesmo NCM de uma vez;
 * - complementos, kits e seus componentes — todos viram linha própria em `sale_items`.
 *
 * Este SELECT tem que casar com o que a tela `/app/fiscal/produtos` lista (ela pede
 * `scope=sellable`). Divergir aqui é o que produzia o beco sem saída: o painel cobrava
 * NCM de N produtos e o botão "Resolver" abria uma tela vazia.
 */
function countProductsMissingNcm(): { missing: number; total: number } {
  const row = getSqlite()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ncm IS NULL OR TRIM(ncm) = '' THEN 1 ELSE 0 END) AS missing
       FROM products
       WHERE deleted_at IS NULL AND active = 1
         AND product_type <> 'servico'
         AND NOT (product_type = 'variante' AND parent_product_id IS NULL)`,
    )
    .get() as { total: number; missing: number | null };
  return { missing: row.missing ?? 0, total: row.total };
}

export function checkReadiness(): Readiness {
  const cfg = getConfig();
  const empresa = getEmpresa();
  const cert = currentCertificate();
  const { missing, total } = countProductsMissingNcm();
  const checks: ReadinessCheck[] = [];

  // 1. Emitente
  const faltaEmpresa: string[] = [];
  if (!empresa.razaoSocial) faltaEmpresa.push('razão social');
  if (!validateCNPJ(empresa.cnpj)) faltaEmpresa.push('CNPJ válido');
  if (!empresa.ie) faltaEmpresa.push('inscrição estadual');
  if (!empresa.rua || !empresa.numero || !empresa.bairro) faltaEmpresa.push('endereço completo');
  if (!empresa.cep) faltaEmpresa.push('CEP');
  if (!empresa.uf) faltaEmpresa.push('UF');
  if (!empresa.municipioIbge) faltaEmpresa.push('município (código IBGE)');
  checks.push({
    id: 'empresa',
    label: 'Dados da empresa',
    status: faltaEmpresa.length ? 'fail' : 'ok',
    detail: faltaEmpresa.length ? `Falta preencher: ${faltaEmpresa.join(', ')}.` : 'Completos.',
    actionLabel: faltaEmpresa.length ? 'Preencher' : undefined,
    step: 1,
  });

  // 2. Certificado
  if (!cert) {
    checks.push({
      id: 'certificado',
      label: 'Certificado digital A1',
      status: 'fail',
      detail: 'Nenhum certificado enviado. É o arquivo .pfx que o seu contador ou a autoridade certificadora forneceu.',
      actionLabel: 'Enviar',
      step: 2,
    });
  } else if (cert.expirado) {
    checks.push({
      id: 'certificado',
      label: 'Certificado digital A1',
      status: 'fail',
      detail: `Venceu em ${cert.validoAte}. Emita um novo antes de continuar.`,
      actionLabel: 'Trocar',
      step: 2,
    });
  } else {
    const perto = cert.diasRestantes <= CERT_WARN_DAYS;
    checks.push({
      id: 'certificado',
      label: 'Certificado digital A1',
      status: perto ? 'warn' : 'ok',
      detail: perto
        ? `${cert.titular} — vence em ${cert.diasRestantes} dia(s), em ${cert.validoAte}. Providencie a renovação.`
        : `${cert.titular} — válido até ${cert.validoAte}.`,
      actionLabel: perto ? 'Trocar' : undefined,
      step: 2,
    });
  }

  // 3. Credenciais
  const semCsc = !hasCsc() || !cfg.idCsc;
  checks.push({
    id: 'csc',
    label: 'CSC (código de segurança do contribuinte)',
    status: semCsc ? 'fail' : 'ok',
    detail: semCsc
      ? 'Falta o CSC e/ou o ID do CSC. São gerados no portal da SEFAZ do seu estado e servem para montar o QR Code da nota.'
      : `Configurado (ID ${cfg.idCsc}).`,
    actionLabel: semCsc ? 'Configurar' : undefined,
    step: 3,
  });

  const semEmissor = !cfg.provider || !hasProviderToken();
  checks.push({
    id: 'emissor',
    label: 'Emissor',
    status: semEmissor ? 'fail' : 'ok',
    detail: semEmissor ? 'Falta escolher o emissor e informar o token de acesso.' : `${cfg.provider} configurado.`,
    actionLabel: semEmissor ? 'Configurar' : undefined,
    step: 3,
  });

  // 4. Produtos
  checks.push({
    id: 'ncm',
    label: 'NCM nos produtos',
    status: missing > 0 ? 'fail' : 'ok',
    detail:
      missing > 0
        ? `${missing} de ${total} produtos ativos estão sem NCM. Todo item da nota precisa do seu NCM.`
        : `Todos os ${total} produtos ativos têm NCM.`,
    actionLabel: missing > 0 ? 'Resolver' : undefined,
    actionHref: missing > 0 ? '/app/fiscal/produtos' : undefined,
  });

  // 5. Ambiente — informativo, nunca bloqueia
  checks.push({
    id: 'ambiente',
    label: 'Ambiente',
    status: cfg.ambiente === 1 ? 'ok' : 'warn',
    detail:
      cfg.ambiente === 1
        ? 'Produção — as notas emitidas têm valor fiscal.'
        : 'Homologação — as notas são de teste e NÃO têm valor fiscal.',
  });

  const ready = checks.every((c) => c.status !== 'fail');
  return {
    ready,
    ambiente: cfg.ambiente,
    podeAtivarProducao: ready && !!cfg.testeOkEm,
    checks,
    produtosSemNcm: missing,
    produtosTotal: total,
  };
}
