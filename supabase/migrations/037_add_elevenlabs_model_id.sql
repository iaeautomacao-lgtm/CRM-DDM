-- 037_add_elevenlabs_model_id.sql
-- Add elevenlabs_model_id column to ai_config table

ALTER TABLE wacrm.ai_config 
  ADD COLUMN IF NOT EXISTS elevenlabs_model_id TEXT DEFAULT 'eleven_multilingual_v2';
