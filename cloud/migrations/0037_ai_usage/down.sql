DROP TABLE IF EXISTS ai_usage;
ALTER TABLE companies DROP COLUMN ai_period;
ALTER TABLE companies DROP COLUMN ai_tokens_used;
ALTER TABLE companies DROP COLUMN ai_token_limit;
