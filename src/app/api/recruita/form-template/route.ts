import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { saveFormTemplate, type FormTemplate } from "@/lib/recruita-form-template";

// POST /api/recruita/form-template
// Body: { template: FormTemplate }
// Persists the admin's edits to system_settings.recruita_form_template_json.
// SuperAdmin only — the template applies to every public application
// form and a typo here costs us every applicant on prod.

const FieldSchema = z.object({
  key: z.string().min(1).max(60),
  label_th: z.string().min(1).max(200),
  label_en: z.string().min(1).max(200),
  enabled: z.boolean(),
  required: z.boolean(),
  display_order: z.number().int().min(0).max(99999)
});

const SectionSchema = z.object({
  key: z.string().min(1).max(60),
  label_th: z.string().min(1).max(200),
  label_en: z.string().min(1).max(200),
  enabled: z.boolean(),
  display_order: z.number().int().min(0).max(99999),
  fields: z.array(FieldSchema).max(60)
});

const TemplateSchema = z.object({
  version: z.number().int().min(1).max(99),
  sections: z.array(SectionSchema).max(40)
});

const BodySchema = z.object({
  template: TemplateSchema
});

export async function POST(req: Request) {
  const user = requireAdmin();
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  saveFormTemplate(parsed.data.template as FormTemplate, user.id);
  return NextResponse.json({ ok: true });
}
