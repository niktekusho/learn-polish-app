CREATE TABLE `comprehension_question` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text_id` integer NOT NULL,
	`question_index` integer NOT NULL,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`correct_index` integer NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`text_id`) REFERENCES `source_text`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cq_text_question_uq` ON `comprehension_question` (`text_id`,`question_index`);