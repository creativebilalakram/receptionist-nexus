
-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  agency_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, agency_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'agency_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- clients
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  niche TEXT,
  services TEXT,
  tone_notes TEXT,
  faq TEXT,
  booking_link TEXT,
  business_hours TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  system_prompt_override TEXT,
  webhook_secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clients_owner_idx ON public.clients(owner_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT ALL ON public.clients TO service_role;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner clients all" ON public.clients FOR ALL TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- slug generator trigger
CREATE OR REPLACE FUNCTION public.set_client_slug()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  base TEXT;
  candidate TEXT;
  n INT := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base := regexp_replace(lower(coalesce(NEW.business_name,'client')), '[^a-z0-9]+', '-', 'g');
    base := trim(both '-' from base);
    IF base = '' THEN base := 'client'; END IF;
    candidate := base;
    WHILE EXISTS (SELECT 1 FROM public.clients WHERE slug = candidate AND id <> COALESCE(NEW.id, gen_random_uuid())) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    NEW.slug := candidate;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER clients_set_slug
BEFORE INSERT ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.set_client_slug();

-- conversations
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL,
  phone TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  qualification JSONB NOT NULL DEFAULT '{}'::jsonb,
  lead_score INT NOT NULL DEFAULT 0,
  manual_takeover BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, subscriber_id)
);
CREATE INDEX conversations_client_idx ON public.conversations(client_id);
CREATE INDEX conversations_subscriber_idx ON public.conversations(subscriber_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner conversations all" ON public.conversations FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = client_id AND c.owner_id = auth.uid()));

-- appointments
CREATE TABLE public.appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_client_idx ON public.appointments(client_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments TO authenticated;
GRANT ALL ON public.appointments TO service_role;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner appointments all" ON public.appointments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = client_id AND c.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.clients c WHERE c.id = client_id AND c.owner_id = auth.uid()));

-- webhook_logs
CREATE TABLE public.webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  payload JSONB,
  response JSONB,
  status_code INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_logs_client_idx ON public.webhook_logs(client_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_logs TO authenticated;
GRANT ALL ON public.webhook_logs TO service_role;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner logs select" ON public.webhook_logs FOR SELECT TO authenticated
  USING (client_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.clients c WHERE c.id = client_id AND c.owner_id = auth.uid()));
