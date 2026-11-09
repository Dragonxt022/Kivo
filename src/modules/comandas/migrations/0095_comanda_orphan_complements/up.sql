-- 0095_comanda_orphan_complements — limpa complementos soltos de dados antigos.
--
-- Antes da correção do voidItem, excluir o produto principal anulava só aquela linha e
-- os complementos do grupo continuavam ativos na comanda (e eram cobrados sozinhos).
-- A regra de "principal" é a mesma da tela e do fechamento: o primeiro item do grupo
-- (menor id), considerando inclusive os já anulados.

-- O aviso "quer pagar" foi calculado com o total antigo; some para o caixa não fechar
-- com um valor que mudou.
UPDATE comandas
   SET ready_for_payment_at = NULL,
       updated_at = datetime('now')
 WHERE status = 'aberta'
   AND ready_for_payment_at IS NOT NULL
   AND id IN (
     SELECT DISTINCT ci.comanda_id
       FROM comanda_items ci
       JOIN comanda_items base
         ON base.comanda_id = ci.comanda_id
        AND base.line_group_uuid = ci.line_group_uuid
        AND base.deleted_at IS NULL
        AND base.voided_at IS NOT NULL
        AND base.id = (
          SELECT MIN(b.id)
            FROM comanda_items b
           WHERE b.comanda_id = ci.comanda_id
             AND b.line_group_uuid = ci.line_group_uuid
             AND b.deleted_at IS NULL
        )
      WHERE ci.deleted_at IS NULL
        AND ci.voided_at IS NULL
        AND ci.line_group_uuid IS NOT NULL
        AND ci.id <> base.id
   );

UPDATE comanda_items
   SET voided_at = datetime('now'),
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND voided_at IS NULL
   AND line_group_uuid IS NOT NULL
   -- Só comandas abertas: em comanda fechada os itens são histórico e a venda já foi
   -- gravada à parte; mexer neles não desfaria a cobrança e só confundiria relatórios.
   AND comanda_id IN (SELECT id FROM comandas WHERE status = 'aberta' AND deleted_at IS NULL)
   AND id IN (
     SELECT ci.id
       FROM comanda_items ci
       JOIN comanda_items base
         ON base.comanda_id = ci.comanda_id
        AND base.line_group_uuid = ci.line_group_uuid
        AND base.deleted_at IS NULL
        AND base.voided_at IS NOT NULL
        AND base.id = (
          SELECT MIN(b.id)
            FROM comanda_items b
           WHERE b.comanda_id = ci.comanda_id
             AND b.line_group_uuid = ci.line_group_uuid
             AND b.deleted_at IS NULL
        )
      WHERE ci.deleted_at IS NULL
        AND ci.voided_at IS NULL
        AND ci.line_group_uuid IS NOT NULL
        AND ci.id <> base.id
   );
