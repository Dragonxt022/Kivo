-- 0032_finance_settle_method — registra COM QUE forma de pagamento uma conta a pagar/receber
-- foi liquidada. Antes disso, o lançamento no caixa acontecia "se por acaso" houvesse um
-- registro aberto no momento do acerto, independente de a conta ter sido paga em dinheiro ou
-- não — agora só forma_pagamento.type = 'dinheiro' mexe na gaveta, e exige caixa aberto.
ALTER TABLE payables ADD COLUMN settle_payment_method_id INTEGER REFERENCES payment_methods(id);
ALTER TABLE receivables ADD COLUMN settle_payment_method_id INTEGER REFERENCES payment_methods(id);
