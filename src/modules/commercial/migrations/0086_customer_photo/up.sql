-- 0086_customer_photo — Foto de identificação do cliente.
--
-- A foto deixa de ser um dado só do consultório (`odonto_patients.photo_file`) e passa a viver
-- no CLIENTE (`customers.photo_file`), reaproveitada por todos os módulos. A migration do Odonto
-- (0087) copia as fotos que já existiam; o Odonto passa a LER daqui.
ALTER TABLE customers ADD COLUMN photo_file TEXT;
