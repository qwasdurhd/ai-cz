CREATE TABLE `deviceModelUsage` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`providerId` int NOT NULL,
	`promptTokens` int NOT NULL DEFAULT 0,
	`completionTokens` int NOT NULL DEFAULT 0,
	`messages` int NOT NULL DEFAULT 0,
	`firstUsedAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deviceModelUsage_id` PRIMARY KEY(`id`),
	CONSTRAINT `deviceModelUsage_code_provider_uq` UNIQUE(`code`,`providerId`)
);
