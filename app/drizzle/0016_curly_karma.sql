CREATE TABLE `report_review` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`gloss_before` text,
	`gloss_provider_before` text,
	`gloss_after` text,
	`mark_before` integer NOT NULL,
	`mark_after` integer NOT NULL,
	`reason` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	`seen_at` integer,
	`undone_at` integer,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `report_review_lemma_idx` ON `report_review` (`lemma_id`);