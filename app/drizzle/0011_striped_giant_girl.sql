CREATE TABLE `passage_question` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer NOT NULL,
	`passage` text NOT NULL,
	`target` text NOT NULL,
	`source` text NOT NULL,
	`text_id` integer,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`correct_index` integer NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`text_id`) REFERENCES `source_text`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `passage_question_lemma_idx` ON `passage_question` (`lemma_id`);