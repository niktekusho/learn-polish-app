CREATE TABLE `llm_call` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`provider` text NOT NULL,
	`call` text NOT NULL,
	`model` text NOT NULL,
	`prompt_chars` integer NOT NULL,
	`ms` integer NOT NULL,
	`error` text
);
