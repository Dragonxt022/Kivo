DROP TABLE bill_settlement_payments;
ALTER TABLE receivables DROP COLUMN installment_group_id;
ALTER TABLE payables DROP COLUMN installment_count;
ALTER TABLE payables DROP COLUMN installment_no;
ALTER TABLE payables DROP COLUMN installment_group_id;
