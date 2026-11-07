ALTER TABLE `conversation` ADD `opening_revealed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_turn` ADD `line_revealed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `conversation` SET `opening_revealed` = 1;--> statement-breakpoint
UPDATE `conversation_turn` SET `line_revealed` = 1 WHERE `line` IS NOT NULL;
