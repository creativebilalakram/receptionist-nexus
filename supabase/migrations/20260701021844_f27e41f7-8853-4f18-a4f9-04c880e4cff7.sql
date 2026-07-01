CREATE UNIQUE INDEX IF NOT EXISTS appointments_no_double_book
ON public.appointments (client_id, scheduled_at)
WHERE status <> 'cancelled';