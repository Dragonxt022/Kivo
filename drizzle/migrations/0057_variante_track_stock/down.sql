-- Sem volta: a migration é um reparo de dado, não uma mudança de schema. Desfazer
-- significaria devolver as variantes ao estado quebrado (sem controle de estoque), e não há
-- registro de quais estavam em 0 por bug e quais por escolha do lojista.
SELECT 1;
