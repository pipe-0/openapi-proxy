-- Every project serves its documents as they are, at /v/<project>/original.
-- An apply keeps that variant; this gives it to the projects that exist now.
-- It selects nothing and states nothing, so its served hash is the same for
-- every project (sha256 of {"overrides":null,"selection":{}}, which a test
-- holds this to).
--
-- A variant someone made and called original keeps what it serves, its id and
-- its keys under another slug. Its URL now serves the original. (No project
-- on the hosted service had one.)
UPDATE `variants` SET `slug` = 'original-1', `updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE `slug` = 'original';
INSERT INTO `variants` (`id`, `project_id`, `slug`, `position`, `name`, `selection`, `overrides`, `icon`, `visibility`, `served_hash`, `created_at`, `updated_at`)
SELECT
  'var_' || lower(hex(randomblob(6))),
  `projects`.`id`,
  'original',
  -1,
  NULL,
  '{}',
  NULL,
  NULL,
  NULL,
  'ba18ad460a6ac3774ff5ed91346bcb17436015e478b39ffe42cf5a7a23a4c4ae',
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM `projects`
WHERE NOT EXISTS (
  SELECT 1 FROM `variants`
  WHERE `variants`.`project_id` = `projects`.`id` AND `variants`.`slug` = 'original'
);
