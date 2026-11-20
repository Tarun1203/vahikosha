-- 003 · TRUNCATE skips row triggers, so block it separately on every table.
CREATE OR REPLACE FUNCTION no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Emptying % is not allowed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION no_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
