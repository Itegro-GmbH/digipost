-- Source for the custom migration enforcing that a booked journal entry balances
-- (decisions/0080-ledger-double-entry-bookkeeping.md: "a booked entry that does not balance is
-- rejected by the database, not only by the UI"). Turned into a real migration file by
-- `pnpm db:generate:custom ledger_balanced_entries` (src/persistence/README.md); never edit the
-- generated migration file directly.
--
-- A deferred constraint trigger, checked at COMMIT rather than per statement: an entry's lines
-- are replaced as a whole (delete, then insert) and its status may flip to `booked` before or
-- after that, so only the state at the end of the transaction is meaningful. A `proposed` entry
-- may be unbalanced while it is being edited; a `booked` one needs at least two lines summing
-- to zero. The error is `raise exception 'ledger_unbalanced'` (SQLSTATE P0001), which
-- `isDbError(err, "raised")` recognizes and the ledger use case maps to `unbalanced`.
--
-- An entry that no longer exists at commit (deleted, or gone with its workspace) is skipped.

create or replace function ledger_assert_entry_balanced(p_entry uuid) returns void
language plpgsql
as $$
declare
  v_status text;
  v_sum bigint;
  v_count integer;
begin
  if p_entry is null then
    return;
  end if;
  select status into v_status from public.journal_entries where id = p_entry;
  if v_status is distinct from 'booked' then
    return;
  end if;
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count from public.journal_lines where entry_id = p_entry;
  if v_sum <> 0 or v_count < 2 then
    raise exception 'ledger_unbalanced'
      using detail = format('journal entry %s: sum %s over %s lines', p_entry, v_sum, v_count);
  end if;
end;
$$;

create or replace function ledger_lines_balanced_trigger() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform ledger_assert_entry_balanced(old.entry_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform ledger_assert_entry_balanced(new.entry_id);
  end if;
  return null;
end;
$$;

create or replace function ledger_entries_balanced_trigger() returns trigger
language plpgsql
as $$
begin
  perform ledger_assert_entry_balanced(new.id);
  return null;
end;
$$;

create constraint trigger journal_lines_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function ledger_lines_balanced_trigger();

create constraint trigger journal_entries_balanced
  after insert or update on public.journal_entries
  deferrable initially deferred
  for each row execute function ledger_entries_balanced_trigger();
