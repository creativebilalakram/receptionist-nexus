
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS icp text,
  ADD COLUMN IF NOT EXISTS objection_notes text;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS current_stage text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS last_reasoning text;
