CREATE TABLE "photos" (
	"id" text PRIMARY KEY NOT NULL,
	"circle_id" text,
	"event_id" text,
	"caption" text NOT NULL,
	"seed" text NOT NULL,
	"object_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "flash" text;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photos_circle_id_idx" ON "photos" USING btree ("circle_id");--> statement-breakpoint
CREATE INDEX "photos_event_id_idx" ON "photos" USING btree ("event_id");