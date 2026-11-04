-- Complementos escolhidos no item principal (ex.: Açaí + Granola + Leite condensado).
-- O KDS precisa mostrar o que acompanha o prato, mesmo que os complementos não sejam
-- produtos roteados individualmente para a cozinha.
ALTER TABLE kitchen_ticket_items ADD COLUMN complements TEXT;
