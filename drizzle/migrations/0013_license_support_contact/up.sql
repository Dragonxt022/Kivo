-- 0013_license_support_contact — contato de suporte (telefone/e-mail) espelhado do
-- cloud/ para exibir no modal de bloqueio quando a licença vence (Fase 6e).

ALTER TABLE license ADD COLUMN support_phone TEXT;
ALTER TABLE license ADD COLUMN support_email TEXT;
