DROP INDEX idx_customers_agreement_company;
ALTER TABLE customers DROP COLUMN agreement_company_id;
ALTER TABLE customers DROP COLUMN loyalty_points;
ALTER TABLE customers DROP COLUMN store_credit_cents;
ALTER TABLE customers DROP COLUMN cep;
