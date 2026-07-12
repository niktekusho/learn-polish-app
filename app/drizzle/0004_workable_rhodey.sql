CREATE TABLE `dict_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`word` text NOT NULL,
	`pos` text NOT NULL,
	`ipa` text,
	`etymology` text,
	`is_mwe` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dict_entry_word_pos_idx` ON `dict_entry` (`word`,`pos`);--> statement-breakpoint
CREATE INDEX `dict_entry_mwe_idx` ON `dict_entry` (`is_mwe`);--> statement-breakpoint
CREATE TABLE `dict_form` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`form` text NOT NULL,
	`tags` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `dict_entry`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dict_form_entry_idx` ON `dict_form` (`entry_id`);--> statement-breakpoint
CREATE INDEX `dict_form_form_idx` ON `dict_form` (`form`);--> statement-breakpoint
CREATE TABLE `dict_sense` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`sense_index` integer NOT NULL,
	`gloss` text NOT NULL,
	`raw_gloss` text,
	`tags` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `dict_entry`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dict_sense_entry_idx` ON `dict_sense` (`entry_id`,`sense_index`);