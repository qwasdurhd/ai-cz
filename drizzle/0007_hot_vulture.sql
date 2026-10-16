CREATE TABLE `deviceProviders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`ip` varchar(64),
	`name` varchar(120) NOT NULL,
	`kind` varchar(24) NOT NULL,
	`model` varchar(150) NOT NULL,
	`endpoint` varchar(500),
	`supportsAttachments` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deviceProviders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sharedProviders` ADD `price` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `siteSettings` ADD `purchaseWhatsapp` varchar(300) DEFAULT 'https://wa.me/message/R4J6XXSDMXB6D1' NOT NULL;--> statement-breakpoint
ALTER TABLE `siteSettings` ADD `purchaseTelegram` varchar(120) DEFAULT 'c5_xc' NOT NULL;--> statement-breakpoint
ALTER TABLE `siteSettings` ADD `purchaseMessage` varchar(500) DEFAULT 'هل تريد شراء نموذج {model}؟' NOT NULL;