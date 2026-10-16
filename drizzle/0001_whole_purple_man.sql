CREATE TABLE `adminSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `adminSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `adminSessions_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `sharedProviders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`kind` enum('openai','anthropic','google','openrouter','custom') NOT NULL,
	`model` varchar(150) NOT NULL,
	`endpoint` varchar(500),
	`apiKeyCipher` text NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sharedProviders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `siteSettings` (
	`id` int NOT NULL DEFAULT 1,
	`siteName` varchar(120) NOT NULL DEFAULT 'Ai - Cz',
	`tagline` varchar(255) NOT NULL DEFAULT 'مختبر الذكاء الخاص بك',
	`description` text,
	`telegramUsername` varchar(120) NOT NULL DEFAULT 'qe_3z',
	`subscriptionRequired` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `siteSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `visitors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ip` varchar(64) NOT NULL,
	`userAgent` text,
	`firstSeen` timestamp NOT NULL DEFAULT (now()),
	`lastSeen` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`requestCount` int NOT NULL DEFAULT 1,
	`blocked` int NOT NULL DEFAULT 0,
	CONSTRAINT `visitors_id` PRIMARY KEY(`id`),
	CONSTRAINT `visitors_ip_unique` UNIQUE(`ip`)
);
