-- 002_state_machine.sql — invariant I2: only legal job-status transitions occur.
-- Enforced in the DB (a trigger), not just app code, so an illegal *raw* UPDATE is rejected too.
-- This is the reviewer-visible signal for I2 (PLAN §4).
--
-- Legal edges:
--   insert    → QUEUED | SCHEDULED
--   QUEUED    → CLAIMED
--   CLAIMED   → RUNNING | QUEUED            (QUEUED = nack / reclaim)
--   RUNNING   → COMPLETED | FAILED | QUEUED (QUEUED = lease reclaim, I7)
--   FAILED    → QUEUED | DLQ                (retry if attempts left, else dead-letter, I4)
--   SCHEDULED → QUEUED                      (scheduler promotes when due, I8)
--   DLQ       → QUEUED                      (manual requeue only, I5/C33)
--   COMPLETED → (terminal)

CREATE OR REPLACE FUNCTION enforce_job_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('QUEUED','SCHEDULED') THEN
      RAISE EXCEPTION 'illegal initial job status: %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;  -- no status change (row updated for other reasons)
  END IF;

  IF NOT (
       (OLD.status = 'QUEUED'    AND NEW.status = 'CLAIMED')
    OR (OLD.status = 'CLAIMED'   AND NEW.status IN ('RUNNING','QUEUED'))
    OR (OLD.status = 'RUNNING'   AND NEW.status IN ('COMPLETED','FAILED','QUEUED'))
    OR (OLD.status = 'FAILED'    AND NEW.status IN ('QUEUED','DLQ'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status = 'QUEUED')
    OR (OLD.status = 'DLQ'       AND NEW.status = 'QUEUED')
  ) THEN
    RAISE EXCEPTION 'illegal job transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_transition_guard
  BEFORE INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_job_transition();
