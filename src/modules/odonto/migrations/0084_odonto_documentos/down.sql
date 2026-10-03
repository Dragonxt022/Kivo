-- 0084_odonto_documentos (rollback).
DROP INDEX IF EXISTS idx_odonto_documents_appointment;
DROP INDEX IF EXISTS idx_odonto_documents_patient;
DROP TABLE IF EXISTS odonto_documents;
DROP INDEX IF EXISTS idx_odonto_doc_templates_tipo;
DROP INDEX IF EXISTS idx_odonto_doc_templates_code;
DROP TABLE IF EXISTS odonto_document_templates;
