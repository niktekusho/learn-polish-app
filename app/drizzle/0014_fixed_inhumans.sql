CREATE TABLE `occurrence_gloss` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` integer NOT NULL,
	`lemma_id` integer NOT NULL,
	`sense` text,
	`italian` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `token`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `occurrence_gloss_token_lemma_uq` ON `occurrence_gloss` (`token_id`,`lemma_id`);--> statement-breakpoint
CREATE INDEX `occurrence_gloss_lemma_idx` ON `occurrence_gloss` (`lemma_id`);