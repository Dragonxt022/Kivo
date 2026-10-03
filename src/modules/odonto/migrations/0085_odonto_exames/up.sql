-- 0085_odonto_exames — exames e imagens do paciente (PR §16 e §17).
--
-- Um exame é UM ARQUIVO (radiografia, tomografia, fotografia clínica, documento ou outro), com
-- paciente, data, tipo, descrição e responsável — como a §16 pede. Guardar um arquivo por linha
-- deixa o paciente com quantos exames precisar, e a listagem filtra por tipo e período.
--
-- O ARQUIVO NÃO MORA NO BANCO. Ele fica no disco (`storage/odonto-exams/`), como o anexo do
-- financeiro e a foto de produto: as tabelas do módulo podem sincronizar entre as máquinas da
-- empresa, e base64 aqui faria cada ciclo de sync carregar radiografia inteira. No banco ficam só
-- referência (nome no disco, nome original, mime, tamanho) e o conteúdo clínico do exame.
--
-- A §17 pede fotografias "antes / durante / depois" e "preparado para comparação futura": a fase
-- do tratamento é o campo `phase`, que já permite agrupar e comparar depois sem migração nova.
CREATE TABLE odonto_exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES odonto_patients(id),
  -- Exame pode estar ligado a um atendimento (radiografia feita na consulta) ou a um plano.
  appointment_id INTEGER REFERENCES odonto_appointments(id),
  plan_id INTEGER REFERENCES odonto_treatment_plans(id),
  professional_id INTEGER REFERENCES odonto_professionals(id),
  type TEXT NOT NULL CHECK (type IN ('radiografia', 'tomografia', 'fotografia', 'documento', 'outro')),
  -- Momento da fotografia clínica (PR §17): antes, durante ou depois do tratamento.
  phase TEXT CHECK (phase IN ('antes', 'durante', 'depois')),
  exam_date TEXT NOT NULL,
  tooth TEXT,
  title TEXT NOT NULL,
  description TEXT,
  -- Referência do arquivo no disco (nome UUID + extensão) e dados originais.
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Exame ou imagem do paciente odontológico (radiografia, tomografia, fotografia clínica antes/durante/depois, documento). O arquivo fica no disco em storage/odonto-exams e aqui fica apenas a referência — imagem em base64 no banco faria a sincronização carregar o arquivo inteiro a cada ciclo.'
);
CREATE INDEX idx_odonto_exams_patient ON odonto_exams(patient_id, exam_date);
CREATE INDEX idx_odonto_exams_tipo ON odonto_exams(type, deleted_at);
CREATE INDEX idx_odonto_exams_fase ON odonto_exams(patient_id, phase);
