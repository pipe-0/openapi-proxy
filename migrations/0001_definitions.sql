-- Projects are described by a definition from here on (see ARCHITECTURE.md).
-- The tables that hold project data are made again in their new shape, and
-- what they held is not carried over: projects, variants, their stored
-- output and API keys start empty. Accounts, workspaces, members, invitations
-- and subscriptions are not touched.
DROP TABLE IF EXISTS `api_keys`;
--> statement-breakpoint
DROP TABLE IF EXISTS `variant_outputs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `project_notifications`;
--> statement-breakpoint
DROP TABLE IF EXISTS `variants`;
--> statement-breakpoint
DROP TABLE IF EXISTS `sources`;
--> statement-breakpoint
DROP TABLE IF EXISTS `released_slugs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `projects`;
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text,
	`visibility` text,
	`overrides` text,
	`managed_by` text DEFAULT 'app' NOT NULL,
	`applied` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`writer` text,
	`spec_version` text NOT NULL,
	`body_hash` text NOT NULL,
	`body_bytes` integer NOT NULL,
	`op_index` text NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`checked_at` integer,
	`next_check_at` integer,
	`watch_until` integer,
	`last_status` text DEFAULT 'ok' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);
--> statement-breakpoint
CREATE INDEX `projects_next_check` ON `projects` (`next_check_at`);
--> statement-breakpoint
CREATE TABLE `released_slugs` (
	`slug` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`released_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text,
	`url` text,
	`file` text,
	`follow` integer DEFAULT false NOT NULL,
	`main` integer DEFAULT false NOT NULL,
	`path_prefix` text,
	`headers` text DEFAULT '[]' NOT NULL,
	`title` text,
	`api_version` text,
	`spec_version` text NOT NULL,
	`upstream_etag` text,
	`upstream_last_modified` text,
	`body_hash` text NOT NULL,
	`body_bytes` integer NOT NULL,
	`body` text NOT NULL,
	`operations` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`last_status` text DEFAULT 'ok' NOT NULL,
	`last_error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sources_project` ON `sources` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_project_name` ON `sources` (`project_id`,`name`);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`name` text,
	`selection` text NOT NULL,
	`overrides` text,
	`icon` text,
	`visibility` text,
	`served_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_project_slug` ON `variants` (`project_id`,`slug`);
--> statement-breakpoint
CREATE TABLE `variant_outputs` (
	`variant_id` text NOT NULL,
	`format` text NOT NULL,
	`version` text DEFAULT 'own' NOT NULL,
	`etag` text NOT NULL,
	`body` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`variant_id`, `format`, `version`),
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_notifications` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by` text,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`access` text NOT NULL,
	`variant_id` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
--> statement-breakpoint
CREATE INDEX `api_keys_organization` ON `api_keys` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `api_keys_variant` ON `api_keys` (`variant_id`);
