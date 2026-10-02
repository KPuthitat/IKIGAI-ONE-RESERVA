// IR request schemas shared by the staff and admin routes (owner 2026-10-01):
// one definition of what a detailed incident report looks like on the wire, so
// the self-service form and the admin form can never drift apart.

import { z } from "zod";
import {
  IR_CATEGORY_KEYS, IR_FACTOR_KEYS, IR_MAX_WHYS, IR_MAX_RECOMMENDATIONS, IR_MAX_PEOPLE
} from "./ir-vocab";
import type { CreateReportInput, ReporterEditInput, IrPersonInput } from "./ir-db";
import type { IrIncidentType, IrSeverity, IrPersonRole } from "./ir-vocab";

const TypeEnum = z.enum(["near_miss", "actual", "complaint"]);
const RoleEnum = z.enum(["involved", "witness", "affected"]);

export const IrPersonBody = z.object({
  user_id: z.number().int().positive().nullable().optional(),
  name: z.string().trim().max(120).nullable().optional(),
  role: RoleEnum,
  note: z.string().trim().max(300).nullable().optional()
}).strict();

const textList = (max: number) => z.array(z.string().trim().max(600)).max(max);

// The reporter's sections — shared by create (all optional but description)
// and the reporter's later edits (everything optional).
const reporterFields = {
  occurred_at: z.string().trim().min(1).max(40),
  location_detail: z.string().trim().max(300).nullable().optional(),
  category: z.string().trim().refine((c) => IR_CATEGORY_KEYS.includes(c), "unknown_category"),
  incident_type: TypeEnum,
  severity: z.number().int().min(1).max(5),
  description: z.string().trim().min(1).max(4000),
  immediate_action: z.string().trim().max(4000).nullable().optional(),
  timeline: z.string().trim().max(4000).nullable().optional(),
  impact: z.string().trim().max(2000).nullable().optional(),
  why_chain: textList(IR_MAX_WHYS).optional(),
  contributing: z.array(z.string().trim().refine((k) => (IR_FACTOR_KEYS as string[]).includes(k), "unknown_factor")).max(IR_FACTOR_KEYS.length).optional(),
  reporter_root_cause: z.string().trim().max(2000).nullable().optional(),
  recommendations: textList(IR_MAX_RECOMMENDATIONS).optional(),
  self_involved: z.boolean().optional(),
  people: z.array(IrPersonBody).max(IR_MAX_PEOPLE).optional()
};

export const IrCreateBody = z.object({
  ...reporterFields,
  anonymous: z.boolean().optional()
}).strict();
export type IrCreateBodyT = z.infer<typeof IrCreateBody>;

export const IrReporterPatchBody = z.object({
  occurred_at: reporterFields.occurred_at.optional(),
  location_detail: reporterFields.location_detail,
  category: reporterFields.category.optional(),
  incident_type: reporterFields.incident_type.optional(),
  severity: reporterFields.severity.optional(),
  description: reporterFields.description.optional(),
  immediate_action: reporterFields.immediate_action,
  timeline: reporterFields.timeline,
  impact: reporterFields.impact,
  why_chain: reporterFields.why_chain,
  contributing: reporterFields.contributing,
  reporter_root_cause: reporterFields.reporter_root_cause,
  recommendations: reporterFields.recommendations,
  self_involved: reporterFields.self_involved,
  people: reporterFields.people
}).strict();
export type IrReporterPatchBodyT = z.infer<typeof IrReporterPatchBody>;

const mapPeople = (p: IrCreateBodyT["people"]): IrPersonInput[] | undefined =>
  p?.map((x) => ({ userId: x.user_id ?? null, name: x.name ?? null, role: x.role as IrPersonRole, note: x.note ?? null }));

export function toCreateInput(d: IrCreateBodyT, branchId: number, reporterUserId: number): CreateReportInput {
  return {
    branchId, reporterUserId,
    isAnonymous: d.anonymous === true,
    occurredAt: d.occurred_at,
    locationDetail: d.location_detail ?? null,
    category: d.category,
    incidentType: d.incident_type as IrIncidentType,
    severity: d.severity as IrSeverity,
    description: d.description,
    immediateAction: d.immediate_action ?? null,
    timeline: d.timeline ?? null,
    impact: d.impact ?? null,
    whyChain: d.why_chain,
    contributing: d.contributing,
    reporterRootCause: d.reporter_root_cause ?? null,
    recommendations: d.recommendations,
    selfInvolved: d.self_involved === true,
    people: mapPeople(d.people)
  };
}

export function toReporterEdit(d: IrReporterPatchBodyT): ReporterEditInput {
  return {
    occurredAt: d.occurred_at,
    locationDetail: d.location_detail,
    category: d.category,
    incidentType: d.incident_type as IrIncidentType | undefined,
    severity: d.severity as IrSeverity | undefined,
    description: d.description,
    immediateAction: d.immediate_action,
    timeline: d.timeline,
    impact: d.impact,
    whyChain: d.why_chain,
    contributing: d.contributing,
    reporterRootCause: d.reporter_root_cause,
    recommendations: d.recommendations,
    selfInvolved: d.self_involved,
    people: mapPeople(d.people)
  };
}
