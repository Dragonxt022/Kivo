-- 0087_odonto_photo_to_customer — Copia a foto do paciente para o cliente.
--
-- A coluna nasceu em `customers` (migration 0086, do módulo commercial). Aqui só migramos o dado
-- que já existia em `odonto_patients.photo_file`: o cliente passa a ser a fonte única da foto.
-- A URL antiga (`/uploads/odonto-patients/…`) continua servida, então as fotos migradas seguem
-- abrindo sem precisar mover arquivo no disco.
UPDATE customers
   SET photo_file = (
     SELECT p.photo_file FROM odonto_patients p
      WHERE p.customer_id = customers.id
        AND p.photo_file IS NOT NULL AND p.photo_file <> ''
        AND p.deleted_at IS NULL
      ORDER BY p.id
      LIMIT 1
   )
 WHERE (photo_file IS NULL OR photo_file = '')
   AND EXISTS (
     SELECT 1 FROM odonto_patients p
      WHERE p.customer_id = customers.id
        AND p.photo_file IS NOT NULL AND p.photo_file <> ''
        AND p.deleted_at IS NULL
   );
