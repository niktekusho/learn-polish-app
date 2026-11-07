CREATE TABLE `character_voice` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`character` text NOT NULL,
	`voice` text NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `story`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_voice_uq` ON `character_voice` (`story_id`,`character`);--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`episode_id` integer NOT NULL,
	`character` text NOT NULL,
	`character_line` text NOT NULL,
	`scene` text NOT NULL,
	`steps` text NOT NULL,
	`role_facts` text,
	`opening` text NOT NULL,
	`due_lemmas` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `story`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `source_text`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_episode_id_unique` ON `conversation` (`episode_id`);--> statement-breakpoint
CREATE TABLE `conversation_turn` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`turn` integer NOT NULL,
	`learner_text` text NOT NULL,
	`line` text,
	`italian` text,
	`understood` integer,
	`steps_ticked` text,
	`hint` text,
	`model_line` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turn_uq` ON `conversation_turn` (`conversation_id`,`turn`);--> statement-breakpoint
ALTER TABLE `llm_call` ADD `conversation_id` integer REFERENCES conversation(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `turn` integer;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `attempt` integer;