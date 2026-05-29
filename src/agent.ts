/*
 * Cedar Kids Therapy referral inbox triage agent.
 *
 * Top-level orchestrator. The heavy lifting lives in focused
 * modules under src/agent/ - this file just wires them together.
 *
 * Module map
 * ----------
 *   src/agent.ts                       <-- you are here
 *     - runAgent (public entry point)
 *     - triageItem (per-item orchestration)
 *     - buildBatchLevelFallback
 *
 *   src/agent/constants.ts             - URGENCY, CLASSIFICATION, ASSIGNEE,
 *                                        POLICY_TOPIC, CHANNEL, INSURANCE,
 *                                        keyword lists, payer fragments,
 *                                        due-date offsets.
 *   src/agent/utils.ts                 - date and string helpers.
 *   src/agent/extraction.ts            - intake field extractors +
 *                                        listMissingIntake.
 *   src/agent/signals.ts               - signal detectors (safeguarding,
 *                                        scheduling, clinical-question,
 *                                        Spanish, etc.).
 *   src/agent/classification.ts        - classifyItem (decision tree).
 *   src/agent/drafts.ts                - message templates and the
 *                                        recipient / channel pickers.
 *   src/agent/safe-call.ts             - safe tool-call wrapper.
 *   src/agent/handlers/index.ts        - dispatchHandler.
 *   src/agent/handlers/<flow>.ts       - one handler per classification.
 *   src/agent/summary.ts               - stderr-only batch summary
 *                                        (deterministic + optional LLM).
 *
 * Tool constraints respected
 * --------------------------
 *   - Every tool call runs inside `withItemContext(item.id, ...)` so the
 *     trace associates the call with the right item.
 *   - `tools_called` is read straight from `getToolCallsForItem(item.id)`
 *     and passed through unchanged. No call_id values are forged or
 *     copied from data/example_output.json.
 *   - `draft_message` is the only outbound; we never imply a message was
 *     sent.
 *   - `find_slots` and `hold_slot` surface options for human review.
 *     Actual scheduling is out of scope.
 *   - `summary` counts on the JSON output are produced by
 *     `buildBatchOutput` in src/index.ts.
 *
 * Urgency decision tree (see ./agent/classification.ts)
 * -----------------------------------------------------
 *   P0  Safeguarding language detected -> escalate same hour.
 *   P1  Same-day cancellation / reschedule / illness.
 *   P2  Default for everything else.
 *   P3  Reserved for low-priority admin / spam.
 *
 * Safety defaults
 * ---------------
 *   - Every item is flagged `requires_human_review = true`. The
 *     validator requires it and it matches Origin's product framing:
 *     the agent drafts, surfaces, and holds; humans decide.
 *   - On any unexpected error a fallback ItemOutput is produced so a
 *     single bad item never crashes the batch.
 *   - Per-tool errors are captured via `safeCall` and surfaced in
 *     `decision_rationale` rather than thrown.
 */

import { getToolCallsForItem, withItemContext } from "./tools.js";
import { CLASSIFICATION, FALLBACK_NEXT_ACTION, URGENCY } from "./agent/constants.js";
import { classifyItem } from "./agent/classification.js";
import { extractIntake, listMissingIntake } from "./agent/extraction.js";
import { dispatchHandler, type HandlerOutcome } from "./agent/handlers/index.js";
import { applySemanticSafetyNet } from "./agent/semantic-enrichment.js";
import { summariseBatch } from "./agent/summary.js";
import { batchAnchor } from "./agent/utils.js";
import type { InboxItem, ItemOutput } from "./types.js";

// =====================================================================
// Per-item orchestration
// =====================================================================

/**
 * Triage a single item end-to-end.
 *
 * The `withItemContext` wrapper is the validator's hook for trace
 * association - every tool call we make inside has to happen on this
 * same async chain. We catch any unexpected error inside the wrapper
 * so partial tool calls still get attributed to the right item.
 */
async function triageItem(item: InboxItem, anchor: Date): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const errors: string[] = [];
    const intake = extractIntake(item);

    // 1. Deterministic keyword classifier produces the baseline decision.
    const keywordDecision = classifyItem(item, intake);

    // 2. Optional LLM semantic safety net. No-op when no API key is
    //    set or when the keyword classifier already caught an urgent
    //    signal. Only upgrades (never downgrades) the decision.
    const initial = await applySemanticSafetyNet(item, keywordDecision);

    let outcome: HandlerOutcome;
    try {
      outcome = await dispatchHandler({ item, intake, initial, anchor, errors });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`handler crash: ${msg}`);
      outcome = {
        classification: initial.classification,
        urgency: initial.urgency,
        decision_rationale: `${initial.rationaleSeed} Handler error - manual triage required.`,
        recommended_next_action: FALLBACK_NEXT_ACTION,
        draft_reply: null,
        task_ids: [],
        escalation: null,
      };
    }

    // Pass tool calls through unchanged - required by the validator.
    const tools_called = getToolCallsForItem(item.id);
    const missingInfo = listMissingIntake(intake);
    const rationaleWithErrors = errors.length
      ? `${outcome.decision_rationale} Tool warnings: ${errors.join("; ")}.`
      : outcome.decision_rationale;

    return {
      item_id: item.id,
      classification: outcome.classification,
      urgency: outcome.urgency,
      // Every item gets human review. Validator requirement and
      // product principle - the agent drafts, holds, and surfaces;
      // humans decide.
      requires_human_review: true,
      extracted_intake: intake,
      missing_info: missingInfo,
      tools_called,
      recommended_next_action: outcome.recommended_next_action,
      draft_reply: outcome.draft_reply,
      task_ids: outcome.task_ids,
      escalation: outcome.escalation,
      decision_rationale: rationaleWithErrors,
    };
  });
}

// =====================================================================
// Public entry point
// =====================================================================

/**
 * Triage a batch of inbox items sequentially.
 *
 * Sequential processing keeps the trace file deterministic and small
 * (8 items is fast), and avoids interleaving tool calls across items
 * which would make debugging the trace painful.
 *
 * A single bad item never crashes the batch: any thrown error inside
 * `triageItem` is caught and converted to a fallback ItemOutput so
 * the remaining items still process.
 *
 * At the end we print a human-readable batch summary to stderr.
 * `output.json` and the audit trace are untouched by the summary
 * step - the validator never sees stderr.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const anchor = batchAnchor();
  const outputs: ItemOutput[] = [];

  for (const item of inbox) {
    try {
      outputs.push(await triageItem(item, anchor));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputs.push(buildBatchLevelFallback(item, msg));
    }
  }

  await summariseBatch(outputs);

  return outputs;
}

/**
 * Emergency fallback for an item whose `triageItem` itself threw
 * before any handler could produce an outcome. Produces a minimally
 * valid ItemOutput so the batch still validates and staff still see
 * the item.
 */
function buildBatchLevelFallback(item: InboxItem, msg: string): ItemOutput {
  return {
    item_id: item.id,
    classification: CLASSIFICATION.OTHER,
    urgency: URGENCY.P2,
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: [`agent crash: ${msg}`],
    tools_called: [],
    recommended_next_action: FALLBACK_NEXT_ACTION,
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Agent crashed before handler could run: ${msg}. Manual triage required.`,
  };
}
