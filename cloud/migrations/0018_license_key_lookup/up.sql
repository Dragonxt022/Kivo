-- Busca da empresa pela chave de licença (POST /api/license/resolve), que é o que permite
-- ativar o Kivo digitando só a chave, sem o UUID da empresa. Sem índice essa consulta é um
-- full scan de `companies` a cada ativação.
--
-- Índice NÃO único de propósito: bases antigas podem ter duas empresas com a mesma chave
-- (nunca houve constraint impedindo), e a migration não pode falhar por causa disso. A rota
-- trata o caso devolvendo 409 em vez de escolher uma empresa ao acaso.
CREATE INDEX idx_companies_license_key_hash ON companies (license_key_hash);
