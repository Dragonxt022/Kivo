-- 0059_dre_categories_stable_uuid — alinha o uuid das categorias de sistema ao
-- determinístico (stableUuid('dre:'+key)) em instalações já existentes.
--
-- As seeds originais (0033) usavam randomblob(16): cada máquina semeava as mesmas 6
-- categorias com uuids DIFERENTES. Como a tabela é replicada pelo sync (que casa por
-- uuid, não por chave natural), o segundo sync de uma segunda máquina estourava o
-- UNIQUE de `key` com "UNIQUE constraint failed: dre_categories.key".
--
-- `synced_at = NULL` força o re-push com o uuid correto na próxima sincronização,
-- para a nuvem passar a guardar o registro com a identidade nova (o registro velho,
-- com uuid aleatório, fica órfão na nuvem — instalação já sincronizada antes desta
-- correção).
UPDATE dre_categories SET uuid = '20bc7a6f-ccb7-5a7c-b10f-00aa97b53c95', synced_at = NULL
  WHERE key = 'receita_bruta_vendas' AND system = 1;
UPDATE dre_categories SET uuid = '07d7f74f-58c2-550c-be9c-b96dd59cc34f', synced_at = NULL
  WHERE key = 'impostos_sobre_vendas' AND system = 1;
UPDATE dre_categories SET uuid = '23f832fc-cfca-55b7-93e9-95fb6e51c677', synced_at = NULL
  WHERE key = 'cmv' AND system = 1;
UPDATE dre_categories SET uuid = '5d7d6451-9413-5e5d-8303-721c884c01a0', synced_at = NULL
  WHERE key = 'outras_despesas_operacionais' AND system = 1;
UPDATE dre_categories SET uuid = '6c4e265d-bd6a-5022-9b57-778b1028f416', synced_at = NULL
  WHERE key = 'taxas_cartao' AND system = 1;
UPDATE dre_categories SET uuid = 'ae94f8ae-2a92-5c8a-8e30-f84d63001a66', synced_at = NULL
  WHERE key = 'outras_despesas_financeiras' AND system = 1;
