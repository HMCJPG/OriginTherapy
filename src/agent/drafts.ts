/**
 * Draft message templates and recipient/channel pickers.
 *
 * Templates are deliberately conservative and operationally specific.
 * They never give clinical advice, never imply the message was sent,
 * and always tell the family what staff will do next.
 *
 * Adding a new template? Keep it under ~3 sentences, always end with
 * a clear "what we'll do next" line, and never reference clinical
 * judgement (no "this is normal" / "this looks concerning").
 */

import { CHANNEL, DRAFT_CHANNEL, LANGUAGE } from "./constants.js";
import { firstName, stripTrailingDots } from "./utils.js";
import type { ExtractedIntake, InboxItem } from "../types.js";

/** Inputs every draft template shares. */
export interface DraftContext {
  intake: ExtractedIntake;
  language: "en" | "es";
}

// ---------------------------------------------------------------------
// Recipient + channel pickers
// ---------------------------------------------------------------------

/**
 * Picks the best recipient identifier for a draft_message call.
 * Order: email > phone > extracted parent_contact string > sender.
 * The mock `draft_message` accepts any string, but emails and phones
 * are what staff actually call back from.
 */
export function pickRecipient(item: InboxItem, intake: ExtractedIntake): string {
  const senderEmail = item.sender.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const bodyEmail = item.body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const email = stripTrailingDots(senderEmail ?? bodyEmail ?? null);
  if (email) return email;

  const phone = item.body.match(/\b\d{3}[-.\s]?\d{4}\b/)?.[0];
  if (phone) return phone;

  if (intake.parent_contact) return intake.parent_contact;

  return item.sender;
}

/**
 * Picks the draft channel from the inbound channel.
 *   voicemail -> phone (call back)
 *   portal    -> portal (reply in-thread)
 *   email/fax -> email (writable thread for intake)
 */
export function pickDraftChannel(item: InboxItem): "portal" | "email" | "phone" {
  switch (item.channel) {
    case CHANNEL.PORTAL:
      return DRAFT_CHANNEL.PORTAL;
    case CHANNEL.VOICEMAIL:
      return DRAFT_CHANNEL.PHONE;
    case CHANNEL.EMAIL:
    case CHANNEL.FAX:
    default:
      return DRAFT_CHANNEL.EMAIL;
  }
}

// ---------------------------------------------------------------------
// Templates - one per scenario
// ---------------------------------------------------------------------

/** Acknowledgement for a clean in-network new referral. */
export function draftInNetworkAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  const discipline = ctx.intake.discipline?.[0] ?? "evaluation";

  if (ctx.language === LANGUAGE.ES) {
    return `Hola ${parent}, recibimos la solicitud de evaluacion de ${discipline} para ${child} y verificamos su seguro. Nuestro equipo de admisiones se comunicara dentro de un dia habil para confirmar el horario. Gracias por contactarnos.`;
  }
  return `Hi ${parent}, we received the ${discipline} evaluation request for ${child} and verified your insurance. Our intake team will reach out within one business day to confirm scheduling. Thanks for reaching out.`;
}

/** Acknowledgement for out-of-network or expired-coverage referrals. */
export function draftBenefitsConversationDraft(
  ctx: DraftContext,
  statusNote: string,
): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";

  if (ctx.language === LANGUAGE.ES) {
    return `Hola ${parent}, recibimos la solicitud para ${child}. ${statusNote} Nuestro equipo de facturacion se comunicara para revisar las opciones antes de programar la cita.`;
  }
  return `Hi ${parent}, thank you for sending ${child}'s referral. ${statusNote} Our billing team will reach out to walk through options before we move forward with scheduling.`;
}

/**
 * Neutral acknowledgement for a safeguarding case.
 *
 * Policy forbids investigative questions or clinical guidance over
 * outbound messages. This template only exists so staff have a
 * starting point for the inevitable phone call.
 */
export function draftSafeguardingAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for reaching out about ${child}. A member of our clinical team will follow up with you directly. We're here to support you and ${child}.`;
}

/** Clinical-question deflection - no advice, offers screening. */
export function draftClinicalQuestionDeflection(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for your question about ${child}. Our clinicians can't share clinical guidance over message, but we can schedule a brief screening or evaluation to give you a clearer answer. Our intake team will follow up to walk through options.`;
}

/** Same-day reschedule / illness call-out acknowledgement. */
export function draftRescheduleAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thanks for letting us know about ${child}. We've alerted our front desk to release today's slot and they'll reach out to find a makeup time. Wishing ${child} a quick recovery.`;
}

/** Acknowledgement when verify_insurance returned "unknown". */
export function draftUnknownInsuranceAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for sending ${child}'s referral. We couldn't confirm coverage from the information provided, so our intake team will reach out to verify benefits before scheduling.`;
}

/**
 * Identity-verification draft for an existing-patient match whose
 * inbound contact disagrees with the stored guardian. Avoids
 * disclosing the patient's stored details until staff confirms
 * identity.
 */
export function draftIdentityVerificationDraft(
  ctx: DraftContext,
  patientLabel: string,
): string {
  const parent = firstName(ctx.intake.parent_contact);
  if (ctx.language === LANGUAGE.ES) {
    return `Hola ${parent}, recibimos su mensaje sobre ${patientLabel}. Antes de programar, nuestro equipo de admisiones se comunicara para confirmar algunos detalles. Gracias por su paciencia.`;
  }
  return `Hi ${parent}, thank you for reaching out about ${patientLabel}. Before we move forward our intake team will be in touch to confirm a few details. Thanks for your patience.`;
}
