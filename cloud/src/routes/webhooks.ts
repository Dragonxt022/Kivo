import { Router } from 'express';
import { getPayment, loadSettings, mapPaymentStatus, verifyWebhookSignature } from '../gateway';
import { getCharge, getChargeByPaymentId, savePaymentSnapshot, settleCharge } from '../charges';

/**
 * Webhook do Mercado Pago (`POST /api/webhooks/mercadopago`).
 *
 * Regras que este arquivo segue, na ordem em que importam:
 *
 *  1. **A notificação não é a fonte da verdade.** Ela só diz "olhe o pagamento X"; o status
 *     é reconferido em `GET /v1/payments/{id}` com o nosso Access Token. Sem isso, uma
 *     notificação forjada marcaria cobrança como paga.
 *  2. **Responde 200 no que não é acionável** (evento de outro tipo, pagamento sem cobrança
 *     nossa, gateway desligado). O Mercado Pago reenvia a cada 15 minutos até receber 200/201
 *     — não queremos fila de retry por evento que decidimos ignorar.
 *  3. **Responde 500 quando a falha é nossa** (banco fora, API fora). Aí o reenvio é bem-vindo.
 *  4. A baixa é idempotente (`settleCharge` só mexe em cobrança pendente), então notificação
 *     repetida — que acontece — não paga duas vezes nem estende a validade duas vezes.
 *
 * A URL pública é configurada no painel do Mercado Pago (Webhooks › Configurar notificações,
 * evento "Pagamentos") e também vai no corpo de cada pagamento criado (`notification_url`).
 */

const router = Router();

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(`[webhook/mp] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

/** `external_reference` combinada na criação do pagamento: `charge:<id>`. */
async function chargeFromReference(reference: string | null): Promise<number | null> {
  const m = /^charge:(\d+)$/.exec(String(reference ?? ''));
  return m ? Number(m[1]) : null;
}

router.post('/mercadopago', async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const body = (req.body ?? {}) as { type?: string; action?: string; data?: { id?: string | number } };
  const tipo = String(body.type ?? query.type ?? '');
  const dataId = String(query['data.id'] ?? body.data?.id ?? '');

  if (!dataId) {
    log('notificação sem data.id — ignorada');
    res.sendStatus(200);
    return;
  }
  if (tipo && tipo !== 'payment') {
    log(`evento "${tipo}" não é de pagamento — ignorado`, { dataId });
    res.sendStatus(200);
    return;
  }

  const settings = await loadSettings();
  if (!settings.accessToken) {
    log('gateway não configurado (sem Access Token) — ignorado', { dataId });
    res.sendStatus(200);
    return;
  }

  const assinatura = verifyWebhookSignature({
    xSignature: req.header('x-signature'),
    xRequestId: req.header('x-request-id'),
    dataId,
    secret: settings.webhookSecret,
  });
  if (assinatura === false) {
    log('assinatura inválida — notificação recusada', { dataId });
    res.sendStatus(401);
    return;
  }
  if (assinatura === null) {
    log('sem segredo de webhook configurado: origem não validada (o status será reconferido na API)', { dataId });
  }

  try {
    const snapshot = await getPayment(dataId, settings);

    const porPagamento = await getChargeByPaymentId(snapshot.paymentId);
    const idDaReferencia = porPagamento ? null : await chargeFromReference(snapshot.externalReference);
    const charge = porPagamento ?? (idDaReferencia ? await getCharge(idDaReferencia) : null);

    if (!charge) {
      log('pagamento sem cobrança correspondente no Kivo — ignorado', {
        pagamento: snapshot.paymentId, referencia: snapshot.externalReference,
      });
      res.sendStatus(200);
      return;
    }

    // Sempre registra o status cru: é o que o painel mostra para explicar por que não caiu.
    await savePaymentSnapshot(charge.id, snapshot, charge.mp_method);

    if (mapPaymentStatus(snapshot.status) === 'paga') {
      const r = await settleCharge(charge.id);
      log(r.settled ? 'cobrança baixada pelo gateway' : 'cobrança já estava baixada', {
        cobranca: charge.id, pagamento: snapshot.paymentId,
        diasEstendidos: r.extendedDays, validade: r.validUntil,
      });
    } else {
      log(`status "${snapshot.status}" (${snapshot.statusDetail ?? 'sem detalhe'}) registrado`, { cobranca: charge.id });
    }
    res.sendStatus(200);
  } catch (e) {
    // 500 faz o Mercado Pago reenviar — é o comportamento certo quando a falha é nossa.
    log('falha ao processar a notificação', { dataId, erro: (e as Error).message });
    res.sendStatus(500);
  }
});

export default router;
