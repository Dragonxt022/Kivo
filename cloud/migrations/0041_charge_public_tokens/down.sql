-- 0041_charge_public_tokens (rollback) — não há o que desfazer: os tokens são apenas
-- identificadores da página pública, e apagá-los quebraria links já enviados ao cliente.
SELECT 1;
