CREATE TABLE `lemma_slip_repair` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slip` text NOT NULL,
	`target` text NOT NULL,
	`repaired_at` integer NOT NULL,
	`seen_at` integer
);
