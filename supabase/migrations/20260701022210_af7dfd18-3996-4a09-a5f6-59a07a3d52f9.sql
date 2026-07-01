ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS followup_count integer NOT NULL DEFAULT 0;