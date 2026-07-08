CREATE TABLE `gloss` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer NOT NULL,
	`sense` text DEFAULT '' NOT NULL,
	`italian` text NOT NULL,
	`provider` text DEFAULT 'stub' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gloss_lemma_sense_uq` ON `gloss` (`lemma_id`,`sense`);--> statement-breakpoint
CREATE TABLE `knowledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer NOT NULL,
	`track` text NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`due` integer NOT NULL,
	`last_review` integer,
	`state` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`elapsed_days` integer DEFAULT 0 NOT NULL,
	`scheduled_days` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_lemma_track_uq` ON `knowledge` (`lemma_id`,`track`);--> statement-breakpoint
CREATE INDEX `knowledge_track_due_idx` ON `knowledge` (`track`,`due`);--> statement-breakpoint
CREATE TABLE `lemma` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma` text NOT NULL,
	`pos` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lemma_lemma_pos_uq` ON `lemma` (`lemma`,`pos`);--> statement-breakpoint
CREATE INDEX `lemma_lemma_idx` ON `lemma` (`lemma`);--> statement-breakpoint
CREATE TABLE `review_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lemma_id` integer NOT NULL,
	`track` text NOT NULL,
	`rating` integer NOT NULL,
	`state_before` integer NOT NULL,
	`state_after` integer NOT NULL,
	`reviewed_at` integer NOT NULL,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_log_lemma_idx` ON `review_log` (`lemma_id`,`track`);--> statement-breakpoint
CREATE INDEX `review_log_reviewed_idx` ON `review_log` (`reviewed_at`);--> statement-breakpoint
CREATE TABLE `source_text` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text_id` integer NOT NULL,
	`lemma_id` integer,
	`surface` text NOT NULL,
	`position` integer NOT NULL,
	`sentence_index` integer NOT NULL,
	`is_space` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`text_id`) REFERENCES `source_text`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lemma_id`) REFERENCES `lemma`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `token_text_idx` ON `token` (`text_id`,`position`);--> statement-breakpoint
CREATE INDEX `token_lemma_idx` ON `token` (`lemma_id`);--> statement-breakpoint
CREATE INDEX `token_surface_idx` ON `token` (`surface`);