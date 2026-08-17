-- 0057_variante_track_stock — conserta as variantes que ficaram sem controle de estoque.
--
-- O PUT de produto zerava `track_stock` sempre que o tipo era 'variante', sem separar o
-- produto-PAI (que de fato não tem saldo próprio) da variante FILHA (que é justamente o
-- item contado na prateleira). Como salvar o preço de uma variante na grade é um PUT nesse
-- mesmo endpoint, bastava digitar o preço para o controle de estoque daquela variante ser
-- desligado em silêncio — e a partir daí o campo de quantidade aparecia travado, sem
-- nenhuma forma de registrar entrada. Corrigido em modules/commercial/productsRoutes.ts.
--
-- Corrigir o código não desfaz o estrago: quem já cadastrou uma grade continua com as
-- filhas zeradas. Este reparo devolve o controle de estoque a elas.
--
-- Escopo estreito de propósito:
--  - só product_type = 'variante' E parent_product_id NOT NULL (filhas, nunca o pai)
--  - só as que estão em 0 hoje
-- Uma filha que o lojista tenha desligado de propósito também volta ligada aqui, e isso é
-- aceito: enquanto o bug existiu não havia como distinguir uma escolha dele de um efeito
-- colateral, e religar é reversível num clique — o contrário (deixar desligado) mantém o
-- produto impossível de estocar.
--
-- `updated_at` é tocado para o motor de sync levar a correção às outras máquinas e à nuvem:
-- `collectDirtyRows` seleciona por `synced_at IS NULL OR synced_at < updated_at`, então sem
-- isso o conserto ficaria só nesta instalação.
UPDATE products
   SET track_stock = 1,
       updated_at = datetime('now')
 WHERE product_type = 'variante'
   AND parent_product_id IS NOT NULL
   AND track_stock = 0
   AND deleted_at IS NULL;
