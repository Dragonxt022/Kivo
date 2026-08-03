-- 0056_fiscal_customers — Inscrição estadual do cliente.
--
-- Só `ie`: `phone` e `cep` já existem em `customers` desde 0004_commercial_base e
-- 0020_commercial_customer_balances (o plano original pedia `phone` de novo por engano).
--
-- Na NFC-e o destinatário é quase sempre consumidor final não contribuinte e nem entra
-- no XML — a IE só passa a importar na NF-e (modelo 55), fora do escopo desta versão.
-- A coluna entra agora para o cadastro já poder ser preenchido enquanto isso.

ALTER TABLE customers ADD COLUMN ie TEXT;
