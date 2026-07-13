-- 036_auto_manage_chat_tags.sql
-- Trigger to automatically assign "IA Conversando" or "Atendimento Humano" tags based on conversation assigned agent

CREATE OR REPLACE FUNCTION wacrm.auto_manage_chat_tags()
RETURNS TRIGGER AS $$
DECLARE
  v_ia_tag_id UUID;
  v_humano_tag_id UUID;
  v_account_id UUID;
  v_user_id UUID;
BEGIN
  -- Get account_id and user_id from conversations context
  v_account_id := NEW.account_id;
  v_user_id := NEW.user_id;

  -- Ensure "IA Conversando" tag exists in this account
  SELECT id INTO v_ia_tag_id 
  FROM wacrm.tags 
  WHERE name = 'IA Conversando' AND account_id = v_account_id 
  LIMIT 1;

  IF v_ia_tag_id IS NULL THEN
    INSERT INTO wacrm.tags (account_id, user_id, name, color)
    VALUES (v_account_id, v_user_id, 'IA Conversando', '#3b82f6') -- Blue
    RETURNING id INTO v_ia_tag_id;
  END IF;

  -- Ensure "Atendimento Humano" tag exists in this account
  SELECT id INTO v_humano_tag_id 
  FROM wacrm.tags 
  WHERE name = 'Atendimento Humano' AND account_id = v_account_id 
  LIMIT 1;

  IF v_humano_tag_id IS NULL THEN
    INSERT INTO wacrm.tags (account_id, user_id, name, color)
    VALUES (v_account_id, v_user_id, 'Atendimento Humano', '#10b981') -- Green
    RETURNING id INTO v_humano_tag_id;
  END IF;

  -- Logic based on assigned_agent_id
  IF NEW.assigned_agent_id IS NULL THEN
    -- IA is handling: Add "IA Conversando" and remove "Atendimento Humano"
    INSERT INTO wacrm.contact_tags (contact_id, tag_id)
    VALUES (NEW.contact_id, v_ia_tag_id)
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

    DELETE FROM wacrm.contact_tags 
    WHERE contact_id = NEW.contact_id AND tag_id = v_humano_tag_id;
  ELSE
    -- Human is handling: Remove "IA Conversando" and add "Atendimento Humano"
    DELETE FROM wacrm.contact_tags 
    WHERE contact_id = NEW.contact_id AND tag_id = v_ia_tag_id;

    INSERT INTO wacrm.contact_tags (contact_id, tag_id)
    VALUES (NEW.contact_id, v_humano_tag_id)
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_auto_manage_chat_tags ON wacrm.conversations;
CREATE TRIGGER trigger_auto_manage_chat_tags
AFTER INSERT OR UPDATE OF assigned_agent_id ON wacrm.conversations
FOR EACH ROW
EXECUTE FUNCTION wacrm.auto_manage_chat_tags();
