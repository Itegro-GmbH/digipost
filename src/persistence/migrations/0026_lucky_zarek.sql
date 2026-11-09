CREATE TABLE "invoice_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"contact_id" uuid,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"related_invoice_id" uuid,
	"actor_user_id" uuid,
	"actor_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_number_sequences" (
	"workspace_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "invoice_number_sequences_workspace_id_year_pk" PRIMARY KEY("workspace_id","year"),
	CONSTRAINT "invoice_number_sequences_last_value_check" CHECK ("invoice_number_sequences"."last_value" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"cancels_invoice_id" uuid,
	"issue_date" date NOT NULL,
	"due_date" date,
	"currency" text NOT NULL,
	"net_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"gross_cents" integer NOT NULL,
	"buyer_name" text NOT NULL,
	"contact_id" uuid,
	"einvoice_input" jsonb NOT NULL,
	"pdf_storage_key" text NOT NULL,
	"xml_storage_key" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"xml_sha256" text NOT NULL,
	"document_id" uuid,
	"created_by_user_id" uuid,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_cancellation_check" CHECK (("invoices"."type" = 'cancellation' and "invoices"."cancels_invoice_id" is not null) or ("invoices"."type" = 'invoice' and "invoices"."cancels_invoice_id" is null)),
	CONSTRAINT "invoices_sequence_check" CHECK ("invoices"."sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancels_invoice_id_invoices_id_fk" FOREIGN KEY ("cancels_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_drafts_workspace_updated_idx" ON "invoice_drafts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "invoice_events_invoice_idx" ON "invoice_events" USING btree ("workspace_id","invoice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_workspace_number_key" ON "invoices" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_workspace_year_sequence_key" ON "invoices" USING btree ("workspace_id","year","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_cancels_invoice_key" ON "invoices" USING btree ("cancels_invoice_id") WHERE "invoices"."cancels_invoice_id" is not null;