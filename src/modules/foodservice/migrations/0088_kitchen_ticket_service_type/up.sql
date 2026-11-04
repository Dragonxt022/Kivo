-- Tipo de atendimento do pedido. O KDS usa para diferenciar "consumir no local"
-- de "entrega" (ícone de prato/garfo x motinha). Tickets antigos ficam como locais,
-- que é o comportamento anterior (o KDS não distinguia nada).
ALTER TABLE kitchen_tickets ADD COLUMN service_type TEXT NOT NULL DEFAULT 'local';
