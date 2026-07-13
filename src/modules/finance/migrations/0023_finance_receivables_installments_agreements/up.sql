-- 0021_finance_receivables_installments_agreements — parcelamento (venda a prazo com
-- N parcelas) e faturamento de convênio, ambos vivendo em receivables. sale_id agrupa
-- N linhas da mesma venda; installment_no/installment_count identificam a posição
-- (ex.: 2/3); agreement_company_id + period_key identificam uma fatura consolidada de
-- convênio (customer_id fica NULL nesse caso — a dívida é da empresa, não do cliente).
ALTER TABLE receivables ADD COLUMN sale_id INTEGER REFERENCES sales(id);
ALTER TABLE receivables ADD COLUMN installment_no INTEGER;
ALTER TABLE receivables ADD COLUMN installment_count INTEGER;
ALTER TABLE receivables ADD COLUMN agreement_company_id INTEGER REFERENCES agreement_companies(id);
ALTER TABLE receivables ADD COLUMN period_key TEXT;

CREATE INDEX idx_receivables_sale ON receivables(sale_id);
CREATE UNIQUE INDEX idx_receivables_agreement_period ON receivables(agreement_company_id, period_key)
  WHERE agreement_company_id IS NOT NULL;

-- Backfill: vendas antigas (antes desta migration) só tinham 1 recebível linkado via
-- sales.receivable_id — preenche sale_id para que cancelSale/listBySale já funcionem
-- para vendas a prazo já existentes, sem precisar de tratamento especial por idade.
UPDATE receivables
SET sale_id = (SELECT s.id FROM sales s WHERE s.receivable_id = receivables.id),
    installment_no = 1, installment_count = 1
WHERE sale_id IS NULL
  AND id IN (SELECT receivable_id FROM sales WHERE receivable_id IS NOT NULL);
