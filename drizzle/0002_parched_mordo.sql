CREATE TABLE `auditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`action` varchar(80) NOT NULL,
	`target` varchar(160),
	`ip` varchar(64),
	`details` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ipAccessRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ip` varchar(64) NOT NULL,
	`providerId` int,
	`allowAllPremium` int NOT NULL DEFAULT 0,
	`expiresAt` timestamp,
	`note` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ipAccessRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sharedProviders` ADD `premium` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `siteSettings` ADD `dailyMessageLimit` int DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `siteSettings` ADD `maintenanceMode` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `visitors` ADD `messageCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `visitors` ADD `quotaDate` varchar(10);