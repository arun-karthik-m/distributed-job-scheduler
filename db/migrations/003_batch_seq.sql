-- 003_batch_seq.sql — a sequence to group sibling jobs of one batch under a shared batch_id.
-- A sequence (not max(batch_id)+1) so concurrent batch submissions can't collide.
CREATE SEQUENCE batch_id_seq;
