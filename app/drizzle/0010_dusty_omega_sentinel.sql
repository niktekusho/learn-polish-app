CREATE TABLE `story` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`genre` text NOT NULL,
	`hook` text NOT NULL,
	`outline` text NOT NULL,
	`planned_episodes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_one_active_uq` ON `story` (`status`) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE `source_text` ADD `story_id` integer REFERENCES story(id);--> statement-breakpoint
ALTER TABLE `source_text` ADD `episode_number` integer;--> statement-breakpoint
ALTER TABLE `source_text` ADD `read_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `source_text_story_episode_uq` ON `source_text` (`story_id`,`episode_number`);