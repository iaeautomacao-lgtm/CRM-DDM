CREATE OR REPLACE FUNCTION wacrm.bulk_upsert_contacts(
  p_account_id uuid,
  p_user_id uuid,
  p_rows jsonb
)
RETURNS TABLE(contact_id uuid, phone_normalized text, is_new boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row jsonb;
  v_phone text;
  v_name text;
  v_email text;
  v_company text;
  v_cpf text;
  v_matched_by_cpf boolean;
  v_contact_id uuid;
  v_phone_norm text;
  v_is_new boolean;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_phone := v_row->>'phone';
    v_name := v_row->>'name';
    v_email := v_row->>'email';
    v_company := v_row->>'company';
    v_cpf := v_row->>'cpf';
    v_matched_by_cpf := false;
    v_contact_id := NULL;
    v_phone_norm := NULL;
    v_is_new := false;
    contact_id := NULL;
    phone_normalized := NULL;
    is_new := false;

    BEGIN
      IF v_cpf IS NOT NULL THEN
        UPDATE wacrm.contacts AS c
        SET
          name = CASE
                   WHEN v_name IS NULL THEN c.name
                   WHEN c.name IS NULL OR c.name = '' OR c.name = c.phone_normalized
                        OR c.name ~ '^\d{10,13}$'
                   THEN v_name
                   ELSE c.name
                 END
        WHERE c.account_id = p_account_id AND c.cpf = v_cpf
        RETURNING c.id, c.phone_normalized INTO v_contact_id, v_phone_norm;

        IF FOUND THEN
          v_matched_by_cpf := true;
          v_is_new := false;
        END IF;
      END IF;

      IF NOT v_matched_by_cpf THEN
        INSERT INTO wacrm.contacts AS c (user_id, account_id, phone, name, email, company, cpf)
        VALUES (p_user_id, p_account_id, v_phone, v_name, v_email, v_company, v_cpf)
        ON CONFLICT (account_id, phone_normalized) WHERE (phone_normalized <> '')
        DO UPDATE SET
          name = CASE
                   WHEN EXCLUDED.name IS NULL THEN c.name
                   WHEN c.name IS NULL OR c.name = '' OR c.name = c.phone_normalized
                        OR c.name ~ '^\d{10,13}$'
                   THEN EXCLUDED.name
                   ELSE c.name
                 END,
          cpf = COALESCE(c.cpf, EXCLUDED.cpf)
        RETURNING c.id, c.phone_normalized, (xmax = 0) INTO v_contact_id, v_phone_norm, v_is_new;
      END IF;

      contact_id := v_contact_id;
      phone_normalized := v_phone_norm;
      is_new := v_is_new;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bulk_upsert_contacts: falha na linha (phone=%, cpf=%): %', v_phone, v_cpf, SQLERRM;
      contact_id := NULL;
      phone_normalized := NULL;
      is_new := false;
    END;

    RETURN NEXT;
  END LOOP;
END;
$$;
