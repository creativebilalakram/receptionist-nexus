
-- meeting_types
CREATE TABLE public.meeting_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name text NOT NULL,
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  description text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  buffer_before_minutes int NOT NULL DEFAULT 0,
  buffer_after_minutes int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meeting_types_one_default_per_client
  ON public.meeting_types(client_id) WHERE is_default = true;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_types TO authenticated;
GRANT ALL ON public.meeting_types TO service_role;
ALTER TABLE public.meeting_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages meeting_types" ON public.meeting_types FOR ALL
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = meeting_types.client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = meeting_types.client_id AND c.owner_id = auth.uid()));

-- availability_rules
CREATE TABLE public.availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  day_of_week int NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL DEFAULT '10:00:00',
  end_time time NOT NULL DEFAULT '19:00:00',
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, day_of_week)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.availability_rules TO authenticated;
GRANT ALL ON public.availability_rules TO service_role;
ALTER TABLE public.availability_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages availability_rules" ON public.availability_rules FOR ALL
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = availability_rules.client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = availability_rules.client_id AND c.owner_id = auth.uid()));

-- blocked_dates
CREATE TABLE public.blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX blocked_dates_client_range ON public.blocked_dates(client_id, start_at, end_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocked_dates TO authenticated;
GRANT ALL ON public.blocked_dates TO service_role;
ALTER TABLE public.blocked_dates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages blocked_dates" ON public.blocked_dates FOR ALL
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = blocked_dates.client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = blocked_dates.client_id AND c.owner_id = auth.uid()));

-- booking_settings (one per client)
CREATE TABLE public.booking_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE REFERENCES public.clients(id) ON DELETE CASCADE,
  min_notice_minutes int NOT NULL DEFAULT 120,
  max_advance_days int NOT NULL DEFAULT 14,
  cancellation_window_hours int NOT NULL DEFAULT 24,
  reminder_hours_before int NOT NULL DEFAULT 24,
  second_reminder_hours_before int NOT NULL DEFAULT 2,
  confirmation_template text NOT NULL DEFAULT 'You''re booked, {{first_name}} — {{meeting_type}} on {{day_of_week}}, {{date}} at {{time}} ({{timezone_label}}). We''ll send a reminder before. If anything changes, just reply here and I''ll handle it.',
  reminder_template text NOT NULL DEFAULT 'Hey {{first_name}} — just a reminder: {{meeting_type}} coming up at {{time}} ({{timezone_label}}). Looking forward.',
  manychat_api_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_settings TO authenticated;
GRANT ALL ON public.booking_settings TO service_role;
ALTER TABLE public.booking_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages booking_settings" ON public.booking_settings FOR ALL
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = booking_settings.client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = booking_settings.client_id AND c.owner_id = auth.uid()));

-- Extend appointments
ALTER TABLE public.appointments
  ADD COLUMN meeting_type_id uuid REFERENCES public.meeting_types(id) ON DELETE SET NULL,
  ADD COLUMN duration_minutes int,
  ADD COLUMN contact_email text,
  ADD COLUMN contact_phone text,
  ADD COLUMN contact_name text,
  ADD COLUMN reminder_sent_at timestamptz,
  ADD COLUMN second_reminder_sent_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN reschedule_count int NOT NULL DEFAULT 0,
  ADD COLUMN booked_via text NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN parent_appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL;

CREATE INDEX appointments_client_scheduled ON public.appointments(client_id, scheduled_at);
CREATE INDEX appointments_status_scheduled ON public.appointments(status, scheduled_at);

-- Seed defaults when a client is created
CREATE OR REPLACE FUNCTION public.seed_client_booking_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.booking_settings (client_id) VALUES (NEW.id)
    ON CONFLICT (client_id) DO NOTHING;

  INSERT INTO public.meeting_types (client_id, name, duration_minutes, is_default, is_active, description)
  VALUES (NEW.id, 'Free Demo', 15, true, true, 'Quick intro and walkthrough.')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.availability_rules (client_id, day_of_week, start_time, end_time, is_enabled)
  SELECT NEW.id, d, '10:00'::time, '19:00'::time, (d BETWEEN 1 AND 5)
  FROM generate_series(0, 6) AS d
  ON CONFLICT (client_id, day_of_week) DO NOTHING;

  RETURN NEW;
END; $$;

REVOKE EXECUTE ON FUNCTION public.seed_client_booking_defaults() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_seed_client_booking_defaults ON public.clients;
CREATE TRIGGER trg_seed_client_booking_defaults
  AFTER INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.seed_client_booking_defaults();

-- Backfill defaults for existing clients
INSERT INTO public.booking_settings (client_id)
SELECT id FROM public.clients
ON CONFLICT (client_id) DO NOTHING;

INSERT INTO public.meeting_types (client_id, name, duration_minutes, is_default, is_active, description)
SELECT c.id, 'Free Demo', 15, true, true, 'Quick intro and walkthrough.'
FROM public.clients c
WHERE NOT EXISTS (SELECT 1 FROM public.meeting_types m WHERE m.client_id = c.id);

INSERT INTO public.availability_rules (client_id, day_of_week, start_time, end_time, is_enabled)
SELECT c.id, d, '10:00'::time, '19:00'::time, (d BETWEEN 1 AND 5)
FROM public.clients c
CROSS JOIN generate_series(0, 6) AS d
ON CONFLICT (client_id, day_of_week) DO NOTHING;
