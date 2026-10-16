CREATE TABLE `chatConversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`ip` varchar(64),
	`conversationId` varchar(64) NOT NULL,
	`title` varchar(255),
	`mode` varchar(16) NOT NULL DEFAULT 'chat',
	`messages` mediumtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `chatConversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deviceProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`ip` varchar(64),
	`userAgent` text,
	`country` varchar(96),
	`region` varchar(96),
	`city` varchar(96),
	`latitude` varchar(32),
	`longitude` varchar(32),
	`locationSource` varchar(24),
	`messageCount` int NOT NULL DEFAULT 0,
	`agentEnabled` int NOT NULL DEFAULT 0,
	`agentExpiresAt` timestamp,
	`banned` int NOT NULL DEFAULT 0,
	`banExpiresAt` timestamp,
	`banReason` varchar(255),
	`assignedProviders` text,
	`note` varchar(255),
	`firstSeen` timestamp NOT NULL DEFAULT (now()),
	`lastSeen` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deviceProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `deviceProfiles_code_unique` UNIQUE(`code`)
);
