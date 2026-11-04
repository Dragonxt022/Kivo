-- Confirmação de visualização do pedido no painel da cozinha. `NULL` = a cozinha
-- ainda não confirmou que viu o pedido; é o que mantém o alarme tocando até alguém
-- tocar em "Visualizei" (ou avançar o pedido, que também confirma).
ALTER TABLE kitchen_tickets ADD COLUMN acknowledged_at TEXT;

-- Tickets que já existiam quando o recurso chegou estão, por definição, na tela de
-- quem atualizou o app. Marcá-los evita que a atualização faça o alarme tocar para
-- pedidos antigos que já estavam visíveis.
UPDATE kitchen_tickets SET acknowledged_at = datetime('now') WHERE acknowledged_at IS NULL;
