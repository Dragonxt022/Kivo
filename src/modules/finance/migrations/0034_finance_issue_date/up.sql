-- 0031_finance_issue_date — data de emissão (distinta do vencimento) em contas a pagar/receber.
-- Nullable: lançamentos antigos ficam sem, exibidos como "—"; novos passam a informar sempre.
ALTER TABLE payables ADD COLUMN issue_date TEXT;
ALTER TABLE receivables ADD COLUMN issue_date TEXT;
