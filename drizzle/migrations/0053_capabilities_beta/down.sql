-- SQLite não suporta DROP COLUMN em versões antigas; a coluna é aditiva e inofensiva.
-- Reverter significa apenas parar de marcar recursos como beta.
UPDATE capabilities SET beta = 0;
