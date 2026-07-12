CREATE TABLE `mwe_occurrence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text_id` integer NOT NULL,
	`lemma_id` integer NOT NULL,
	`start_position` integer NOT NULL,
	`end_position` integer NOT NULL,
	`sentence_index` integer NOT NULL,
	FOREIGN KEY (`text_id`) REFERENCES `source_text`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mwe_occ_text_idx` ON `mwe_occurrence` (`text_id`,`start_position`);--> statement-breakpoint
CREATE INDEX `mwe_occ_lemma_idx` ON `mwe_occurrence` (`lemma_id`);