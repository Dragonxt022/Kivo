-- 0031_remove_example_themes — tira da loja os temas de exemplo gerados por `scripts/gen-theme-packs.js`.
--
-- Aqueles 6 packs (vitrine-viva, bem-estar-verde, gelato-doce, maos-a-obra, patinha-feliz,
-- sabor-na-chapa) eram demonstração e saíram de `cloud/seed-themes/`. O seed é só upsert, então
-- apagar as pastas não remove as linhas já cadastradas — esta migration faz a limpeza em cada
-- ambiente (local e produção). O tema real da loja passa a ser só o 3D Max.
--
-- Remoção por slug (lista fechada): não toca em tema criado à mão no painel.

DELETE g FROM theme_grants g
  JOIN themes t ON t.id = g.theme_id
 WHERE t.slug IN ('vitrine-viva', 'bem-estar-verde', 'gelato-doce', 'maos-a-obra', 'patinha-feliz', 'sabor-na-chapa');

DELETE FROM themes
 WHERE slug IN ('vitrine-viva', 'bem-estar-verde', 'gelato-doce', 'maos-a-obra', 'patinha-feliz', 'sabor-na-chapa');
