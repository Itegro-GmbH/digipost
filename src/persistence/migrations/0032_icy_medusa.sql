CREATE TABLE "ledger_booking_advice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_booking_advice_workspace_document_key" UNIQUE("workspace_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_booking_advice" ADD CONSTRAINT "ledger_booking_advice_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_workspace_document_idx" ON "journal_lines" USING btree ("workspace_id","document_id");