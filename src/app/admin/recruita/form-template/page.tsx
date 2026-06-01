import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getFormTemplate } from "@/lib/recruita-form-template";
import { getLang } from "@/lib/lang-server";
import FormTemplateClient from "./FormTemplateClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · ฟอร์มใบสมัคร" };

// /admin/recruita/form-template — edit the standard application form
// template. Loads the saved template (or DEFAULT_TEMPLATE on first
// open) and hands it to the client editor. Server-side just verifies
// auth + reads the row.

export default function FormTemplatePage() {
  requireSuperAdmin();
  const lang = getLang();
  const template = getFormTemplate();
  return <FormTemplateClient template={template} lang={lang} />;
}
