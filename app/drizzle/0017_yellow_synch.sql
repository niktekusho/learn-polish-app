PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_report_review` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer,
	`word` text NOT NULL,
	`note` text,
	`gloss_before` text,
	`gloss_provider_before` text,
	`gloss_after` text,
	`mark_before` integer NOT NULL,
	`mark_after` integer NOT NULL,
	`reason` text NOT NULL,
	`names` text DEFAULT '[]' NOT NULL,
	`reviewed_at` integer NOT NULL,
	`seen_at` integer,
	`undone_at` integer,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_report_review`("id", "lemma_id", "word", "note", "gloss_before", "gloss_provider_before", "gloss_after", "mark_before", "mark_after", "reason", "names", "reviewed_at", "seen_at", "undone_at") SELECT r."id", r."lemma_id", l."lemma", r."note", r."gloss_before", r."gloss_provider_before", r."gloss_after", r."mark_before", r."mark_after", r."reason", '[]', r."reviewed_at", r."seen_at", r."undone_at" FROM `report_review` r JOIN `lemma` l ON l."id" = r."lemma_id";--> statement-breakpoint
DROP TABLE `report_review`;--> statement-breakpoint
ALTER TABLE `__new_report_review` RENAME TO `report_review`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `report_review_lemma_idx` ON `report_review` (`lemma_id`);--> statement-breakpoint
ALTER TABLE `lemma` ADD `flag_token_id` integer REFERENCES token(id) ON DELETE set null;