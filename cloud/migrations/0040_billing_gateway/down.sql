-- 0040_billing_gateway (rollback) — remove os campos do gateway de pagamento.
DROP INDEX idx_charges_mp_payment ON charges;
DROP INDEX uq_charges_public_token ON charges;
ALTER TABLE charges
  DROP COLUMN mp_updated_at,
  DROP COLUMN mp_init_point,
  DROP COLUMN mp_ticket_url,
  DROP COLUMN mp_qr_code_base64,
  DROP COLUMN mp_qr_code,
  DROP COLUMN mp_status_detail,
  DROP COLUMN mp_status,
  DROP COLUMN mp_method,
  DROP COLUMN mp_payment_id,
  DROP COLUMN extends_days,
  DROP COLUMN payer_email,
  DROP COLUMN public_token;
