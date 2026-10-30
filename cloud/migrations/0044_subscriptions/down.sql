-- 0044_subscriptions (rollback).
ALTER TABLE charges DROP FOREIGN KEY fk_charges_subscription;
DROP INDEX idx_charges_subscription ON charges;
DROP INDEX uq_charges_subscription_payment ON charges;
ALTER TABLE charges
  DROP COLUMN subscription_payment_id,
  DROP COLUMN subscription_id;
DROP TABLE IF EXISTS company_subscriptions;
