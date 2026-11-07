CREATE TABLE `learner_profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`job` text NOT NULL,
	`city` text NOT NULL,
	`partner` text NOT NULL,
	`hobbies` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "learner_profile_single_row" CHECK("learner_profile"."id" = 1)
);
