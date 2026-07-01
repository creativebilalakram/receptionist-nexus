UPDATE public.clients
SET faq = COALESCE(faq, '') || E'\n\nQ: Where are you located / office location?\nA: Smart Receptions is a fully digital service — no physical office walk-ins. Our onboarding and support team is based in Karachi, Pakistan, and we serve salons across Pakistan, UAE, Qatar, UK, USA, Canada, and Australia via WhatsApp and Zoom.'
WHERE slug = 'smart-receptions'
  AND (faq IS NULL OR faq NOT ILIKE '%office location%');