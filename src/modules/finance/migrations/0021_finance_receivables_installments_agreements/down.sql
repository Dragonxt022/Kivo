DROP INDEX idx_receivables_agreement_period;
DROP INDEX idx_receivables_sale;
ALTER TABLE receivables DROP COLUMN period_key;
ALTER TABLE receivables DROP COLUMN agreement_company_id;
ALTER TABLE receivables DROP COLUMN installment_count;
ALTER TABLE receivables DROP COLUMN installment_no;
ALTER TABLE receivables DROP COLUMN sale_id;
