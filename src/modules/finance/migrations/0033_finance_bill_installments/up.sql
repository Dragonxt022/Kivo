-- 0033_finance_bill_installments — parcelamento de contas criadas manualmente (não vindas de
-- venda a prazo, que já usa sales.id como chave de agrupamento). installment_group_id é uma
-- chave de agrupamento genérica (UUID), independente de tabela — usada tanto na criação com N
-- parcelas quanto no rateio automático de pagamento parcial (transferir diferença pra próxima
-- parcela, ou criar uma nova quando não há próxima).
ALTER TABLE payables ADD COLUMN installment_group_id TEXT;
ALTER TABLE payables ADD COLUMN installment_no INTEGER;
ALTER TABLE payables ADD COLUMN installment_count INTEGER;
ALTER TABLE receivables ADD COLUMN installment_group_id TEXT;

CREATE INDEX idx_payables_installment_group ON payables(installment_group_id);
CREATE INDEX idx_receivables_installment_group ON receivables(installment_group_id);

-- Uma linha por forma de pagamento usada num acerto (split payment) — settle_payment_method_id
-- (0032) continua preenchido na própria conta só quando o acerto usa uma forma só.
CREATE TABLE bill_settlement_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('payable', 'receivable')),
  bill_id INTEGER NOT NULL,
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Uma linha por forma de pagamento usada num acerto de conta a pagar/receber (split payment) — várias linhas por acerto quando dividido em mais de uma forma.'
);
CREATE INDEX idx_bill_settlement_payments_bill ON bill_settlement_payments(entity, bill_id);
