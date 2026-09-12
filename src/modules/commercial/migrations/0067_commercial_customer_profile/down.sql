DROP INDEX IF EXISTS idx_customers_birthday;
ALTER TABLE customers DROP COLUMN birthday;
ALTER TABLE customers DROP COLUMN tags;
