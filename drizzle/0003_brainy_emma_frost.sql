CREATE TABLE "wallet_txns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_nonneg" CHECK ("wallets"."balance_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_txns_user_id_idx" ON "wallet_txns" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_reference_idx" ON "wallet_txns" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");