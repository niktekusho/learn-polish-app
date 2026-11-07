CREATE TABLE `character_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`character` text NOT NULL,
	`lines` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `story`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_memory_uq` ON `character_memory` (`story_id`,`character`);