CREATE TABLE `daily_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_activity_day_kind_uq` ON `daily_activity` (`day`,`kind`);--> statement-breakpoint
ALTER TABLE `review_log` ADD `stability_before` real;--> statement-breakpoint
ALTER TABLE `review_log` ADD `stability_after` real;