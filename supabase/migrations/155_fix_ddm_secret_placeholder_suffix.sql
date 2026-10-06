-- Repair malformed DDM tool URLs such as:
--   tk={{secret.DDM_TOKEN}}<credential-fragment>&...
-- A valid placeholder must be the complete tk= parameter value.
-- Idempotent and scoped to DDM tools only.

BEGIN;

UPDATE wacrm.flow_nodes AS n
SET config = jsonb_set(
  n.config,
  '{tools}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN tool->'http'->>'url' LIKE '%ddmacordos.com%'
         AND tool->'http'->>'url' LIKE '%{{secret.DDM_TOKEN}}%'
        THEN jsonb_set(
          tool,
          '{http,url}',
          to_jsonb(
            regexp_replace(
              tool->'http'->>'url',
              '(tk=\{\{secret\.DDM_TOKEN\}\})[^&]*',
              '\1',
              'g'
            )
          )
        )
        ELSE tool
      END
    )
    FROM jsonb_array_elements(n.config->'tools') AS tool
  )
)
WHERE n.config ? 'tools'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(n.config->'tools') AS tool
    WHERE tool->'http'->>'url' LIKE '%ddmacordos.com%'
      AND tool->'http'->>'url' ~ 'tk=\{\{secret\.DDM_TOKEN\}\}[^&]+'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM wacrm.flow_nodes n
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(n.config->'tools','[]'::jsonb)) AS tool
    WHERE tool->'http'->>'url' LIKE '%ddmacordos.com%'
      AND tool->'http'->>'url' ~ 'tk=\{\{secret\.DDM_TOKEN\}\}[^&]+'
  ) THEN
    RAISE EXCEPTION 'Malformed DDM secret placeholder still present after cleanup';
  END IF;
END
$$;

COMMIT;
