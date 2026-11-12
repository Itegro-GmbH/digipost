ALTER TABLE "documents" ADD COLUMN "tax_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "net_total_cents" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tax_total_cents" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "pass_through_cents" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "reverse_charge" boolean;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "service_date" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "service_period_from" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "service_period_to" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tax_check" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tax_check_check" CHECK ("documents"."tax_check" is null or "documents"."tax_check" in ('consistent', 'inconsistent'));