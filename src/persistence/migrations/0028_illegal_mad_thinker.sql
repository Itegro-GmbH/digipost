CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_date" date NOT NULL,
	"document_date" date,
	"service_date" date,
	"text" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"origin" text NOT NULL,
	"origin_reason" text,
	"source_key" text,
	"document_id" uuid,
	"transaction_id" uuid,
	"correction_of_entry_id" uuid,
	"filing_id" uuid,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dismissed_at" timestamp with time zone,
	"user_edited_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"booked_at" timestamp with time zone,
	"booked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "journal_entries_dismissed_check" CHECK ("journal_entries"."dismissed_at" is null or "journal_entries"."status" = 'proposed'),
	CONSTRAINT "journal_entries_booked_check" CHECK ("journal_entries"."status" = 'proposed' or "journal_entries"."booked_at" is not null),
	CONSTRAINT "journal_entries_revision_check" CHECK ("journal_entries"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "journal_entry_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid,
	"entry_ref" uuid NOT NULL,
	"revision" integer NOT NULL,
	"change_kind" text NOT NULL,
	"reason" text,
	"booking_date" date NOT NULL,
	"snapshot" jsonb,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"tax_code" text,
	"tax_role" text,
	"generated_from_line_position" integer,
	"text" text,
	CONSTRAINT "journal_lines_entry_position_key" UNIQUE("entry_id","position"),
	CONSTRAINT "journal_lines_amount_check" CHECK ("journal_lines"."amount_cents" <> 0),
	CONSTRAINT "journal_lines_position_check" CHECK ("journal_lines"."position" >= 1),
	CONSTRAINT "journal_lines_tax_role_check" CHECK ("journal_lines"."tax_role" is null or "journal_lines"."tax_code" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"group" text NOT NULL,
	"open_items" boolean DEFAULT false NOT NULL,
	"owner_type" text,
	"owner_bank_account_id" uuid,
	"owner_contact_id" uuid,
	"owner_platform" text,
	"owner_person_name" text,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_workspace_number_key" UNIQUE("workspace_id","number"),
	CONSTRAINT "ledger_accounts_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "ledger_accounts_number_check" CHECK ("ledger_accounts"."number" ~ '^[0-9]{4,8}$'),
	CONSTRAINT "ledger_accounts_owner_check" CHECK ((coalesce("ledger_accounts"."owner_type", '') = 'bank_account') = ("ledger_accounts"."owner_bank_account_id" is not null)
        and (coalesce("ledger_accounts"."owner_type", '') = 'contact') = ("ledger_accounts"."owner_contact_id" is not null)
        and (coalesce("ledger_accounts"."owner_type", '') = 'platform') = ("ledger_accounts"."owner_platform" is not null)
        and (coalesce("ledger_accounts"."owner_type", '') = 'person') = ("ledger_accounts"."owner_person_name" is not null))
);
--> statement-breakpoint
CREATE TABLE "ledger_advisor_balance_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text,
	"balance_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_advisor_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"file_name" text,
	"uploaded_by_user_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_advisor_balances_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "ledger_advisor_balances_period_check" CHECK ("ledger_advisor_balances"."period_from" <= "ledger_advisor_balances"."period_to")
);
--> statement-breakpoint
CREATE TABLE "ledger_booking_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"counterparty_pattern" text,
	"direction" text DEFAULT 'any' NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code" text,
	"payment_account_id" uuid,
	"no_document" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"learned_from_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_booking_rules_target_check" CHECK ("ledger_booking_rules"."contact_id" is not null or "ledger_booking_rules"."counterparty_pattern" is not null),
	CONSTRAINT "ledger_booking_rules_hits_check" CHECK ("ledger_booking_rules"."hits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"submitted_on" date,
	"amount_cents" integer,
	"corrects_filing_id" uuid,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_filings_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "ledger_filings_period_check" CHECK ("ledger_filings"."period_from" <= "ledger_filings"."period_to"),
	CONSTRAINT "ledger_filings_submitted_check" CHECK ("ledger_filings"."status" = 'draft' or "ledger_filings"."submitted_on" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledger_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_handovers_period_check" CHECK ("ledger_handovers"."period_from" <= "ledger_handovers"."period_to")
);
--> statement-breakpoint
CREATE TABLE "ledger_open_item_match_lines" (
	"workspace_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	CONSTRAINT "ledger_open_item_match_lines_match_id_line_id_pk" PRIMARY KEY("match_id","line_id"),
	CONSTRAINT "ledger_open_item_match_lines_line_key" UNIQUE("line_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_open_item_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_open_item_matches_note_check" CHECK ("ledger_open_item_matches"."kind" = 'match' or "ledger_open_item_matches"."note" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledger_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"vat_period" text DEFAULT 'month' NOT NULL,
	"vat_basis" text DEFAULT 'soll' NOT NULL,
	"start_date" date,
	"chart" text DEFAULT 'skr04' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_filing_fk" FOREIGN KEY ("workspace_id","filing_id") REFERENCES "public"."ledger_filings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_revisions" ADD CONSTRAINT "journal_entry_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_revisions" ADD CONSTRAINT "journal_entry_revisions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."journal_entries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."ledger_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_advisor_balance_lines" ADD CONSTRAINT "ledger_advisor_balance_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_advisor_balance_lines" ADD CONSTRAINT "ledger_advisor_balance_lines_upload_fk" FOREIGN KEY ("workspace_id","upload_id") REFERENCES "public"."ledger_advisor_balances"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_advisor_balances" ADD CONSTRAINT "ledger_advisor_balances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_booking_rules" ADD CONSTRAINT "ledger_booking_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_booking_rules" ADD CONSTRAINT "ledger_booking_rules_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."ledger_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_booking_rules" ADD CONSTRAINT "ledger_booking_rules_payment_account_fk" FOREIGN KEY ("workspace_id","payment_account_id") REFERENCES "public"."ledger_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_filings" ADD CONSTRAINT "ledger_filings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_filings" ADD CONSTRAINT "ledger_filings_corrects_filing_id_ledger_filings_id_fk" FOREIGN KEY ("corrects_filing_id") REFERENCES "public"."ledger_filings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_handovers" ADD CONSTRAINT "ledger_handovers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_open_item_match_lines" ADD CONSTRAINT "ledger_open_item_match_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_open_item_match_lines" ADD CONSTRAINT "ledger_open_item_match_lines_match_id_ledger_open_item_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."ledger_open_item_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_open_item_match_lines" ADD CONSTRAINT "ledger_open_item_match_lines_line_id_journal_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_open_item_matches" ADD CONSTRAINT "ledger_open_item_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_open_item_matches" ADD CONSTRAINT "ledger_open_item_matches_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."ledger_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_settings" ADD CONSTRAINT "ledger_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_workspace_source_key" ON "journal_entries" USING btree ("workspace_id","source_key") WHERE "journal_entries"."source_key" is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_workspace_booking_date_idx" ON "journal_entries" USING btree ("workspace_id","booking_date");--> statement-breakpoint
CREATE INDEX "journal_entries_workspace_document_idx" ON "journal_entries" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE INDEX "journal_entries_workspace_transaction_idx" ON "journal_entries" USING btree ("workspace_id","transaction_id");--> statement-breakpoint
CREATE INDEX "journal_entry_revisions_entry_idx" ON "journal_entry_revisions" USING btree ("workspace_id","entry_ref","revision");--> statement-breakpoint
CREATE INDEX "journal_entry_revisions_changed_idx" ON "journal_entry_revisions" USING btree ("workspace_id","changed_at");--> statement-breakpoint
CREATE INDEX "journal_lines_workspace_account_idx" ON "journal_lines" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_workspace_bank_owner_key" ON "ledger_accounts" USING btree ("workspace_id","owner_bank_account_id") WHERE "ledger_accounts"."owner_bank_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_workspace_contact_owner_key" ON "ledger_accounts" USING btree ("workspace_id","owner_contact_id") WHERE "ledger_accounts"."owner_contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_workspace_platform_owner_key" ON "ledger_accounts" USING btree ("workspace_id","owner_platform") WHERE "ledger_accounts"."owner_platform" is not null;--> statement-breakpoint
CREATE INDEX "ledger_advisor_balance_lines_upload_idx" ON "ledger_advisor_balance_lines" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "ledger_advisor_balances_workspace_idx" ON "ledger_advisor_balances" USING btree ("workspace_id","period_to");--> statement-breakpoint
CREATE INDEX "ledger_booking_rules_workspace_idx" ON "ledger_booking_rules" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE INDEX "ledger_filings_workspace_period_idx" ON "ledger_filings" USING btree ("workspace_id","period_from","period_to");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_filings_original_key" ON "ledger_filings" USING btree ("workspace_id","kind","period_from","period_to") WHERE "ledger_filings"."corrects_filing_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_filings_open_correction_key" ON "ledger_filings" USING btree ("corrects_filing_id") WHERE "ledger_filings"."corrects_filing_id" is not null and "ledger_filings"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "ledger_handovers_workspace_idx" ON "ledger_handovers" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_open_item_matches_account_idx" ON "ledger_open_item_matches" USING btree ("workspace_id","account_id");