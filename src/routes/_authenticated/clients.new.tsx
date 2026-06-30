import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/clients.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/clients/new")({
  head: () => ({ meta: [{ title: "New client — Receptionist Engine" }] }),
  component: NewClient,
});

function NewClient() {
  const navigate = useNavigate();
  const create = useServerFn(createClient);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    business_name: "",
    niche: "",
    services: "",
    tone_notes: "",
    faq: "",
    booking_link: "",
    business_hours: "Mon–Fri 9am–6pm",
    timezone: "America/New_York",
    system_prompt_override: "",
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const row = await create({ data: form });
      toast.success("Client created");
      navigate({ to: "/clients/$id", params: { id: row.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create client");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Onboard</p>
      <h1 className="mt-2 text-display">New client.</h1>
      <p className="mt-2 text-sm text-muted-foreground">A new AI receptionist will be provisioned with its own webhook secret.</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <Field label="Business name" required>
          <Input value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} required maxLength={120} />
        </Field>
        <Field label="Niche" hint="e.g. dental clinic, med spa, real-estate broker">
          <Input value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} maxLength={120} />
        </Field>
        <Field label="Services" hint="One per line.">
          <Textarea rows={4} value={form.services} onChange={(e) => setForm({ ...form, services: e.target.value })} />
        </Field>
        <Field label="Tone guidance" hint="How should the AI sound for this client?">
          <Textarea rows={3} value={form.tone_notes} onChange={(e) => setForm({ ...form, tone_notes: e.target.value })} />
        </Field>
        <Field label="FAQ" hint="Common Q&A the AI should know cold.">
          <Textarea rows={4} value={form.faq} onChange={(e) => setForm({ ...form, faq: e.target.value })} />
        </Field>
        <Field label="Booking link" hint="Cal.com, Calendly, or Google booking URL.">
          <Input type="url" placeholder="https://" value={form.booking_link} onChange={(e) => setForm({ ...form, booking_link: e.target.value })} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Business hours">
            <Input value={form.business_hours} onChange={(e) => setForm({ ...form, business_hours: e.target.value })} />
          </Field>
          <Field label="Timezone">
            <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </Field>
        </div>
        <Field label="Advanced — system prompt override" hint="Optional. Appended to the default prompt.">
          <Textarea rows={3} value={form.system_prompt_override} onChange={(e) => setForm({ ...form, system_prompt_override: e.target.value })} />
        </Field>

        <div className="flex gap-3 pt-4">
          <Button type="submit" disabled={loading}>{loading ? "Creating…" : "Create client"}</Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: "/clients" })}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children, required }: { label: string; hint?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <Label className="flex items-baseline justify-between">
        <span>{label}{required && <span className="text-primary"> *</span>}</span>
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
