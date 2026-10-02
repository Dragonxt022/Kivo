-- 0041_charge_public_tokens — toda cobrança nasce com link de pagamento.
--
-- A 0040 criou `charges.public_token`, mas ele só era gerado quando o admin clicava em
-- "Gerar Pix" — ou seja, a cobrança recém-criada ainda não tinha link para mandar ao cliente
-- (e o cliente não conseguia escolher boleto/cartão sozinho). Agora o token nasce junto com a
-- cobrança; aqui ficam as que já existiam.
--
-- Idempotente: só preenche o que está vazio.
UPDATE charges SET public_token = UUID() WHERE public_token IS NULL;
