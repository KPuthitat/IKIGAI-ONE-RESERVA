// INSIGNA — Mode A (in-process) public surface.
//
// Re-exports the functions a booking-side caller is allowed to
// touch. Keeping the import path single (`@/lib/insigna`) makes
// the call sites trivially auditable: every `import.*from
// "@/lib/insigna"` is a wall crossing, and grepping that string
// gives you the complete attack surface from the booking side.
//
// Anything NOT re-exported here is private — including the salt
// itself, the rate-limit bucket internals, and any future helper
// that would expose a reverse path. If something feels useful to
// re-export, ask "would adding this widen the wall?" first.

export {
  hashLineUserId,
  hashPhone,
  generateAnonymousHash,
  isCustomerHash
} from "./hash";

export {
  upsertCustomer,
  getCustomerProfile,
  deleteCustomer,
  type InsignaCustomer
} from "./customers";

export {
  syncReservation,
  updateReservationStatus,
  type ReservationChannel,
  type ReservationStatus
} from "./reservations";

export {
  startVisit,
  addOrders,
  addMenuInteractions,
  endVisit,
  type PartyType,
  type TableZone,
  type MenuCategory,
  type MenuAction
} from "./visits";

// Booking-side integration helpers — the only place raw LINE userIds
// or phones cross into the INSIGNA module. The bridge hashes them
// at the boundary so callers stay one-liners. Calling sites:
//   - src/app/api/admin/reserva/bookings (admin creates booking)
//   - src/app/api/bookings (customer LIFF booking)
//   - admin reserva booking-status PATCH routes (when admin flips
//     confirmed → seated / cancelled / no_show)
export {
  onBookingCreated,
  onBookingStatusChanged
} from "./booking-bridge";

// Feedback service (Phase 5) + AI stubs (Phase 2 hooks).
export {
  submitFeedback,
  analyzeFeedbackSentiment,
  synthesizePersonaDescription,
  generateDailyBriefing,
  type InsignaFeedback,
  type SubmitFeedbackArgs
} from "./feedback";

// Persona tagging (Phase 7). recomputePersonaTag fires automatically
// from endVisit; the bulk recompute is exposed for the nightly job.
export {
  recomputePersonaTag,
  recomputeAllPersonas
} from "./persona";

// Churn risk scoring (Phase 8). Same pattern: per-customer recompute
// runs inline on endVisit; the bulk recompute drives the nightly
// outreach list (listHighChurnRisk).
export {
  recomputeChurnScore,
  recomputeAllChurn,
  listHighChurnRisk
} from "./churn";

// Marketing campaigns (Phase 9). Slug-keyed upsert + touchpoint
// ingestion + per-campaign performance read.
export {
  upsertCampaign,
  setCampaignSpend,
  listCampaigns,
  addTouchpoint,
  getCampaignPerformance,
  type InsignaCampaign
} from "./campaigns";

// Multi-model attribution (Phase 10). computeAttribution fires
// automatically from endVisit; channelPerformance powers the
// channel comparison view.
export {
  computeAttribution,
  channelPerformance,
  type AttributionModel
} from "./attribution";
