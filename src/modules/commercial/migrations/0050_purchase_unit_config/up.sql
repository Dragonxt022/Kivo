-- 0050_purchase_unit_config — unidade de compra e conversão por produto.
-- purchase_unit: a unidade usada na compra (ex.: 'cx', 'un', 'kg', 'saco').
--   Se NULL ou igual a unit, não há conversão — compra-se na mesma unidade de venda.
-- purchase_unit_qty: quantas unidades de venda cabem em uma unidade de compra.
--   Ex.: vende por 'un' (unit='un'), compra por 'cx' (purchase_unit='cx'),
--   purchase_unit_qty=12 significa "cada caixa tem 12 unidades".
ALTER TABLE products ADD COLUMN purchase_unit TEXT;
ALTER TABLE products ADD COLUMN purchase_unit_qty REAL;
