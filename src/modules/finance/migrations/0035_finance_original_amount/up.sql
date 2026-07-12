-- 0035_finance_original_amount — preserva o valor original de contas a pagar/receber
-- mesmo quando amount_cents é alterado por liquidação parcial (rateio automático).
ALTER TABLE payables ADD COLUMN original_amount_cents INTEGER;
ALTER TABLE receivables ADD COLUMN original_amount_cents INTEGER;

-- Backfill: registros existentes recebem o amount_cents atual como original.
UPDATE payables SET original_amount_cents = amount_cents WHERE original_amount_cents IS NULL;
UPDATE receivables SET original_amount_cents = amount_cents WHERE original_amount_cents IS NULL;
