ALTER TABLE `llm_call` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `prompt` blob;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `response` blob;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `llm_call` ADD `api_ms` integer;