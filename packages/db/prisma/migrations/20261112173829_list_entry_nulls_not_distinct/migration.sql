-- "All platforms" list entries have platform = NULL. Make NULLs collide in the unique index so the
-- same value can't be added twice for all platforms (Postgres 15+).
DROP INDEX "list_entry_organizationId_list_kind_value_platform_key";
CREATE UNIQUE INDEX "list_entry_organizationId_list_kind_value_platform_key"
  ON "list_entry" ("organizationId", "list", "kind", "value", "platform") NULLS NOT DISTINCT;
