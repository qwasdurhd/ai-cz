ALTER TABLE `chatConversations` ADD `expiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `chatConversations` ADD `tokens` int DEFAULT 0 NOT NULL;