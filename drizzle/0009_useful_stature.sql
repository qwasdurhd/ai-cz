CREATE TABLE `deviceMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`target` varchar(40) NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` mediumtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deviceMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messageReads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`messageId` int NOT NULL,
	`code` varchar(40) NOT NULL,
	`readAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messageReads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supportMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`threadId` int NOT NULL,
	`sender` enum('user','admin') NOT NULL,
	`body` mediumtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `supportMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supportThreads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`ip` varchar(64),
	`userAgent` text,
	`unreadForAdmin` int NOT NULL DEFAULT 0,
	`unreadForUser` int NOT NULL DEFAULT 0,
	`lastMessageAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `supportThreads_id` PRIMARY KEY(`id`),
	CONSTRAINT `supportThreads_code_unique` UNIQUE(`code`)
);
