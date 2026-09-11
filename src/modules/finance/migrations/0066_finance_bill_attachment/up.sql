-- 0066_finance_bill_attachment — anexo de documento (boleto, nota, comprovante) em
-- contas a pagar/receber. O arquivo vive no disco (storage/bill-attachments) e aqui fica
-- só a referência — mesmo desenho da logo da empresa e das fotos de produto: guardar o
-- arquivo em base64 no banco faria cada ciclo de sync carregar o documento inteiro.
--
-- `attachment_file` é o nome do arquivo no disco (UUID + extensão); `attachment_name` é o
-- nome original que o usuário enviou, usado no download. As colunas NÃO sincronizam
-- (ver module.manifest.ts): o arquivo é desta máquina, e uma referência sincronizada sem o
-- arquivo viraria um link morto no segundo computador da loja.
ALTER TABLE payables ADD COLUMN attachment_file TEXT;
ALTER TABLE payables ADD COLUMN attachment_name TEXT;
ALTER TABLE payables ADD COLUMN attachment_mime TEXT;
ALTER TABLE payables ADD COLUMN attachment_size INTEGER;
ALTER TABLE receivables ADD COLUMN attachment_file TEXT;
ALTER TABLE receivables ADD COLUMN attachment_name TEXT;
ALTER TABLE receivables ADD COLUMN attachment_mime TEXT;
ALTER TABLE receivables ADD COLUMN attachment_size INTEGER;
