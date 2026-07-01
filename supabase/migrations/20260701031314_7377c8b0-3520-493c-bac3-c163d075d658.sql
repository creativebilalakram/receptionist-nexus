
-- Feature flag on clients
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS use_job_queue boolean NOT NULL DEFAULT true;

-- outbound_jobs table
CREATE TABLE IF NOT EXISTS public.outbound_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  last_error text,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.outbound_jobs TO authenticated;
GRANT ALL ON public.outbound_jobs TO service_role;

ALTER TABLE public.outbound_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage jobs for their clients"
ON public.outbound_jobs FOR ALL
TO authenticated
USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = outbound_jobs.client_id AND c.owner_id = auth.uid()))
WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = outbound_jobs.client_id AND c.owner_id = auth.uid()));

CREATE INDEX IF NOT EXISTS outbound_jobs_queue_idx
  ON public.outbound_jobs (status, next_run_at)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS outbound_jobs_conversation_idx
  ON public.outbound_jobs (conversation_id);

CREATE OR REPLACE FUNCTION public.touch_outbound_jobs_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_outbound_jobs_touch ON public.outbound_jobs;
CREATE TRIGGER trg_outbound_jobs_touch
  BEFORE UPDATE ON public.outbound_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_outbound_jobs_updated_at();

-- Atomic claim
CREATE OR REPLACE FUNCTION public.claim_outbound_job(_worker_id text)
RETURNS SETOF public.outbound_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_id uuid;
BEGIN
  SELECT id INTO claimed_id
  FROM public.outbound_jobs
  WHERE status = 'queued' AND next_run_at <= now()
  ORDER BY next_run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF claimed_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.outbound_jobs
     SET status = 'running',
         locked_at = now(),
         locked_by = _worker_id,
         attempts = attempts + 1,
         updated_at = now()
   WHERE id = claimed_id
  RETURNING *;
END; $$;

-- Recycle stale locks (>90s in running)
CREATE OR REPLACE FUNCTION public.reset_stale_outbound_jobs()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  WITH updated AS (
    UPDATE public.outbound_jobs
       SET status = 'queued',
           locked_at = NULL,
           locked_by = NULL,
           next_run_at = now(),
           updated_at = now()
     WHERE status = 'running' AND locked_at < now() - interval '90 seconds'
    RETURNING 1
  )
  SELECT count(*) INTO n FROM updated;
  RETURN n;
END; $$;
