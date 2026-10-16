ALTER TABLE `ipAccessRules` MODIFY COLUMN `ip` varchar(64) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `ipAccessRules` ADD `code` varchar(40);--> statement-breakpoint
ALTER TABLE `sharedProviders` ADD `description` text;--> statement-breakpoint
ALTER TABLE `sharedProviders` ADD `publicUntil` timestamp;