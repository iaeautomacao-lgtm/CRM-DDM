-- Migration 113: lock distribuido para crons executados por HTTP.
--
-- O Phusion Passenger pode atender requisicoes concorrentes em processos
-- diferentes; portanto um boolean/Map em memoria nao impede sobreposicao.
-- O lock abaixo vive no Postgres, expira automaticamente se o processo
-- morrer e so pode ser manipulado pela service_role.

CREATE TABLE IF NOT EXISTS wacrm.cron_locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_locks_expires_at
  ON wacrm.cron_locks (expires_at);

CREATE OR REPLACE FUNCTION wacrm.try_acquire_cron_lock(
  p_name TEXT,
  p_owner_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 600
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_owner TEXT;
  v_ttl INTEGER;
BEGIN
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 600), 30), 3600);

  INSERT INTO wacrm.cron_locks (name, owner_id, acquired_at, expires_at)
  VALUES (
    p_name,
    p_owner_id,
    now(),
    now() + make_interval(secs => v_ttl)
  )
  ON CONFLICT (name) DO UPDATE
  SET
    owner_id = EXCLUDED.owner_id,
    acquired_at = now(),
    expires_at = EXCLUDED.expires_at
  WHERE wacrm.cron_locks.expires_at <= now()
  RETURNING owner_id INTO v_owner;

  RETURN COALESCE(v_owner = p_owner_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.release_cron_lock(
  p_name TEXT,
  p_owner_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM wacrm.cron_locks
  WHERE name = p_name
    AND owner_id = p_owner_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.try_acquire_cron_lock(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION wacrm.release_cron_lock(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.try_acquire_cron_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION wacrm.release_cron_lock(TEXT, TEXT) TO service_role;
