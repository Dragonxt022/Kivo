-- Versão do app até a qual a licença dá direito a atualização gratuita (linha
-- de versão minor — ex.: licenciado em 0.3.0 cobre até 0.3.x). Editada
-- manualmente pelo admin no momento da venda ou renovação. Sem valor
-- definido, a empresa não tem limite de versão registrado ainda.
ALTER TABLE companies ADD COLUMN licensed_version VARCHAR(20) NULL;
