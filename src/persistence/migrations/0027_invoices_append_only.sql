-- Source for the custom migration making `invoices` and `invoice_events` append-only
-- (decisions/0079-outgoing-invoices.md, GoBD: an issued invoice and its audit trail are never
-- changed or removed). Turned into a real migration file by
-- `pnpm db:generate:custom invoices_append_only` (src/persistence/README.md); never edit the
-- generated migration file directly, edit this source and regenerate instead.
--
-- Two independent layers, so neither an application bug nor a hand-written query against the
-- runtime connection can rewrite an issued invoice:
--
-- 1. A trigger refuses every UPDATE and TRUNCATE, for every role including the owner, and
--    every DELETE, with exactly one exception: the DELETE that a workspace deletion cascades
--    (the user's decision: a workspace may still be deleted once its admin confirmed every
--    invoice was downloaded, `WorkspaceUseCases.deleteWorkspace`). That cascade is recognized
--    by its effect, not by a session flag anyone could set: the cascade's own DELETE runs
--    after the parent `workspaces` row is already gone in the same transaction, so the row
--    being deleted no longer has a workspace. A direct DELETE of an invoice whose workspace
--    still exists is refused.
-- 2. `app_runtime` (the application's connection, decisions/0004-three-database-roles.md)
--    loses UPDATE, DELETE and TRUNCATE on both tables; `alter default privileges` in the
--    grants migration had granted them like on every table. The cascade above still works:
--    Postgres runs a foreign key's cascade action with the privileges of the referencing
--    table's owner, not of the role that deleted the workspace.

create or replace function invoices_refuse_change() returns trigger
language plpgsql
as $$
begin
  -- Nested rather than one `and`: for the statement-level TRUNCATE trigger there is no `old`
  -- row to read at all.
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.workspaces where id = old.workspace_id) then
      return old;
    end if;
  end if;
  raise exception 'GoBD: % is append-only, % is not allowed', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger invoices_append_only
  before update or delete on public.invoices
  for each row execute function invoices_refuse_change();

create trigger invoices_no_truncate
  before truncate on public.invoices
  for each statement execute function invoices_refuse_change();

create trigger invoice_events_append_only
  before update or delete on public.invoice_events
  for each row execute function invoices_refuse_change();

create trigger invoice_events_no_truncate
  before truncate on public.invoice_events
  for each statement execute function invoices_refuse_change();

revoke update, delete, truncate on public.invoices from app_runtime;
revoke update, delete, truncate on public.invoice_events from app_runtime;
