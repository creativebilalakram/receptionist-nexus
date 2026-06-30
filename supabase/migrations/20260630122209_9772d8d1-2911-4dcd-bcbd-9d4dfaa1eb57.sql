
ALTER TABLE public.booking_settings
  ADD COLUMN IF NOT EXISTS auto_buffer_after_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS effective_end_at timestamptz;

UPDATE public.appointments
   SET effective_end_at = scheduled_at + ((COALESCE(duration_minutes,30) + 15) || ' minutes')::interval
 WHERE effective_end_at IS NULL;
