-- 0042_contracts (rollback).
ALTER TABLE charges DROP FOREIGN KEY fk_charges_contract;
DROP INDEX idx_charges_contract ON charges;
ALTER TABLE charges
  DROP COLUMN installment_number,
  DROP COLUMN contract_id;
DROP TABLE IF EXISTS contract_number_seq;
DROP TABLE IF EXISTS contracts;
