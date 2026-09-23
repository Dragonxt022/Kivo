-- 0076_purchase_item_lot — lote e validade por item de compra.
--
-- A compra é criada como rascunho e recebida depois; sem estas colunas o lote/validade
-- digitado na conferência se perderia entre criar e receber. Na hora de receber, o item
-- vira uma entrada de estoque que cria o lote (ver purchaseInbound.postPurchaseItems).
ALTER TABLE purchase_items ADD COLUMN lot_code TEXT;
ALTER TABLE purchase_items ADD COLUMN lot_expires_at TEXT;
