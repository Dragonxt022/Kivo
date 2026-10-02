import { Router } from 'express';
import fs from 'node:fs';
import { getPool } from '../db';
import { requireAdminAuth } from '../adminAuth';
import { parseAmountCents } from '../format';
import { publicPayUrl } from '../gateway';
import {
  MAX_CONTRACT_PDF_BYTES, cancelContract, contractCharges, contractDocumentPath, contractProgressLabel,
  createContractWithCharges, deleteContract, generateMissingCharges, getContract, getContractSummary,
  isoDate, listContracts, removeContractDocument, saveContractDocument, setContractStatus,
} from '../contracts';

/**
 * Contratos no painel do cloud.
 *
 * Fluxo comercial: instala e ativa o teste → cliente usa os 15 dias → contrato assinado. Aqui
 * o admin registra o contrato (número, prazo, valor mensal, PDF assinado) e o Kivo gera o
 * **bloco de cobranças** de uma vez — 12 meses viram 12 parcelas, cada uma com seu vencimento
 * e já valendo Pix/boleto/cartão na tela de Cobranças do cliente.
 *
 * O documento vai como base64 no corpo JSON (o cloud não usa multipart em lugar nenhum:
 * catálogo, temas e mensagens seguem o mesmo padrão) e fica em `storage/contracts/`.
 */

const router = Router();

/**
 * Volta para a tela certa com o aviso na query string: a lista global, a aba Contratos da
 * empresa ou a própria página do contrato — conforme de onde o formulário veio.
 */
function voltarPara(
  req: { body?: Record<string, unknown> },
  res: import('express').Response,
  uuid: string | null,
  kind: 'ok' | 'error',
  msg: string,
  contractId?: number,
): void {
  const destino = String(req.body?.voltar ?? '');
  if (destino === 'contrato' && contractId) {
    res.redirect(`/admin/contracts/${contractId}?${kind}=${encodeURIComponent(msg)}`);
    return;
  }
  if (destino === 'empresa' && uuid) {
    res.redirect(`/admin/companies/${uuid}?${kind}=${encodeURIComponent(msg)}#contratos`);
    return;
  }
  res.redirect(`/admin/contracts?${kind}=${encodeURIComponent(msg)}`);
}

// ─────────────────────────────── Lista e detalhe ───────────────────────────────

router.get('/contracts', requireAdminAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const contratos = await listContracts({ status });
  const [rows] = await getPool().query('SELECT company_uuid, name FROM companies ORDER BY name');
  res.render('contracts', {
    contratos,
    empresas: rows as { company_uuid: string; name: string }[],
    progresso: contractProgressLabel,
    filtroStatus: status,
    maxPdfMb: Math.round(MAX_CONTRACT_PDF_BYTES / 1048576),
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.get('/contracts/:id', requireAdminAuth, async (req, res) => {
  const contrato = await getContractSummary(Number(req.params.id));
  if (!contrato) {
    res.redirect('/admin/contracts?error=' + encodeURIComponent('Contrato não encontrado.'));
    return;
  }
  const parcelas = await contractCharges(contrato.id);
  res.render('contract-detail', {
    contrato,
    parcelas,
    progresso: contractProgressLabel,
    publicUrl: publicPayUrl,
    maxPdfMb: Math.round(MAX_CONTRACT_PDF_BYTES / 1048576),
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

// ─────────────────────────────── Criação (com o bloco) ───────────────────────────────

function contratoDoFormulario(body: Record<string, unknown>) {
  const months = Number(String(body.months ?? '12'));
  const monthly = parseAmountCents(body.monthlyAmount);
  const firstDueDate = isoDate(body.firstDueDate);
  const extendsDays = Number(String(body.extendsDays ?? '30'));
  const erro = !Number.isFinite(months) || months < 1 || months > 120
    ? 'Prazo inválido: informe de 1 a 120 meses.'
    : monthly <= 0
      ? 'Informe o valor mensal.'
      : !firstDueDate
        ? 'Informe a data do primeiro vencimento.'
        : null;
  return { months, monthly, firstDueDate, extendsDays, erro };
}

router.post('/companies/:uuid/contracts', requireAdminAuth, async (req, res) => {
  const uuid = String(req.params.uuid);
  await criarContrato(req, res, uuid);
});

router.post('/contracts', requireAdminAuth, async (req, res) => {
  const uuid = String((req.body ?? {}).companyUuid ?? '').trim();
  if (!uuid) {
    voltarPara(req, res, null, 'error', 'Escolha a empresa do contrato.');
    return;
  }
  await criarContrato(req, res, uuid);
});

async function criarContrato(
  req: import('express').Request,
  res: import('express').Response,
  companyUuid: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { months, monthly, firstDueDate, extendsDays, erro } = contratoDoFormulario(body);
  if (erro) {
    voltarPara(req, res, companyUuid, 'error', erro);
    return;
  }

  try {
    const contrato = await createContractWithCharges({
      companyUuid,
      title: String(body.title ?? '') || null,
      months,
      monthlyAmountCents: monthly,
      firstDueDate: firstDueDate!,
      extendsDays,
      payerEmail: String(body.payerEmail ?? '') || null,
      signedOn: isoDate(body.signedOn),
      notes: String(body.notes ?? '') || null,
      contractNumber: String(body.contractNumber ?? '') || null,
    });

    // PDF é opcional e vem junto do mesmo formulário (quando o admin já tem o arquivo em mãos).
    const base64 = String(body.documentBase64 ?? '');
    if (base64) {
      const r = await saveContractDocument(contrato.id, { name: String(body.documentName ?? 'contrato.pdf'), base64 });
      if (!r.ok) {
        voltarPara(req, res, companyUuid, 'error',
          `Contrato ${contrato.contractNumber} criado com ${contrato.months} parcelas, mas o PDF não foi anexado: ${r.error}`);
        return;
      }
    }

    voltarPara(req, res, companyUuid, 'ok',
      `Contrato ${contrato.contractNumber} criado: ${contrato.months} parcela(s) de ${(contrato.monthlyAmountCents / 100).toFixed(2)} ` +
      `até ${contrato.lastDueDate.split('-').reverse().join('/')} — total ${(contrato.totalCents / 100).toFixed(2)}.`);
  } catch (e) {
    console.error('[contratos] falha ao criar', { companyUuid, erro: (e as Error).message });
    voltarPara(req, res, companyUuid, 'error', `Não foi possível criar o contrato: ${(e as Error).message}`);
  }
}

// ─────────────────────────────── Parcelas ───────────────────────────────

router.post('/contracts/:id/charges', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  const criadas = await generateMissingCharges(contrato.id);
  voltarPara(req, res, contrato.company_uuid, 'ok', criadas.length
    ? `${criadas.length} parcela(s) gerada(s) para o contrato ${contrato.contract_number}.`
    : 'O bloco de parcelas já estava completo.');
});

// ─────────────────────────────── Documento ───────────────────────────────

router.post('/contracts/:id/document', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const r = await saveContractDocument(contrato.id, {
    name: String(body.documentName ?? 'contrato.pdf'),
    base64: String(body.documentBase64 ?? ''),
  });
  voltarPara(req, res, contrato.company_uuid, r.ok ? 'ok' : 'error',
    r.ok ? 'Contrato em PDF anexado.' : r.error, contrato.id);
});

router.get('/contracts/:id/document', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  const caminho = contrato ? contractDocumentPath(contrato) : null;
  if (!contrato || !caminho) {
    res.status(404).send('Documento não encontrado.');
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${contrato.document_name ?? 'contrato.pdf'}"`);
  fs.createReadStream(caminho).pipe(res);
});

router.post('/contracts/:id/document/remove', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  await removeContractDocument(contrato.id);
  voltarPara(req, res, contrato.company_uuid, 'ok', 'Anexo removido.', contrato.id);
});

// ─────────────────────────────── Ciclo de vida ───────────────────────────────

router.post('/contracts/:id/cancel', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  const { canceladas } = await cancelContract(contrato.id);
  voltarPara(req, res, contrato.company_uuid, 'ok',
    `Contrato ${contrato.contract_number} cancelado — ${canceladas} parcela(s) em aberto cancelada(s). ` +
    'As já pagas continuam no histórico.', contrato.id);
});

router.post('/contracts/:id/status', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  const novo = String((req.body ?? {}).status ?? '');
  if (!['ativo', 'concluido', 'cancelado'].includes(novo)) {
    voltarPara(req, res, contrato.company_uuid, 'error', 'Status inválido.', contrato.id);
    return;
  }
  await setContractStatus(contrato.id, novo as 'ativo' | 'concluido' | 'cancelado');
  voltarPara(req, res, contrato.company_uuid, 'ok', `Contrato ${contrato.contract_number} agora está ${novo}.`, contrato.id);
});

router.post('/contracts/:id/delete', requireAdminAuth, async (req, res) => {
  const contrato = await getContract(Number(req.params.id));
  if (!contrato) {
    voltarPara(req, res, null, 'error', 'Contrato não encontrado.');
    return;
  }
  const r = await deleteContract(contrato.id);
  if (!r.ok) {
    voltarPara(req, res, contrato.company_uuid, 'error', r.motivo ?? 'Não foi possível apagar.');
    return;
  }
  if (contrato.document_file) {
    const caminho = contractDocumentPath(contrato);
    if (caminho) fs.rmSync(caminho, { force: true });
  }
  voltarPara(req, res, contrato.company_uuid, 'ok', `Contrato ${contrato.contract_number} apagado.`);
});

export default router;
