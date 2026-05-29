/**
 * Batch summary printed to stderr at the end of `npm run triage`.
 *
 * Strictly stderr-only. Never touches output.json or the audit
 * trace - the validator does not look at this output.
 *
 * Two paths:
 *   1. ANTHROPIC_API_KEY unset -> deterministic counts block.
 *   2. ANTHROPIC_API_KEY set   -> Claude Haiku narrative summary
 *                                 wrapped around the deterministic
 *                                 counts so reviewers always see
 *                                 verifiable numbers.
 *
 * Any failure in the LLM path (auth error, network error, malformed
 * response) is caught and downgrades silently to the deterministic
 * path - the triage run itself never fails because of a summary
 * issue.
 */

import { URGENCY } from "./constants.js";
import type { ItemOutput, Urgency } from "../types.js";

// ---------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------

/**
 * Aggregate stats over a triaged batch. Computed once and shared by
 * both the deterministic summary and the LLM prompt.
 */
export interface BatchStats {
  total: number;
  byUrgency: Record<Urgency, number>;
  byClassification: Record<string, number>;
  toolCallCount: number;
  distinctTools: string[];
  topMissingFields: Array<{ field: string; count: number }>;
  escalated: Array<{ item_id: string; severity: "P0" | "P1"; reason: string }>;
  sameDay: Array<{
    item_id: string;
    urgency: Urgency;
    child: string | null;
    action: string;
  }>;
}

/**
 * Pure stats compute. Same numbers feed both the fallback summary and
 * the LLM prompt, so we only count once.
 */
export function computeBatchStats(items: ItemOutput[]): BatchStats {
  const byUrgency: Record<Urgency, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const byClassification: Record<string, number> = {};
  const toolNames = new Set<string>();
  const missingFieldCounts = new Map<string, number>();
  let toolCallCount = 0;

  const escalated: BatchStats["escalated"] = [];
  const sameDay: BatchStats["sameDay"] = [];

  for (const item of items) {
    byUrgency[item.urgency] = (byUrgency[item.urgency] ?? 0) + 1;
    byClassification[item.classification] =
      (byClassification[item.classification] ?? 0) + 1;

    for (const call of item.tools_called) {
      toolCallCount += 1;
      toolNames.add(call.name);
    }

    for (const field of item.missing_info) {
      missingFieldCounts.set(field, (missingFieldCounts.get(field) ?? 0) + 1);
    }

    if (item.escalation) {
      escalated.push({
        item_id: item.item_id,
        severity: item.escalation.severity,
        reason: item.escalation.reason,
      });
    }

    if (item.urgency === URGENCY.P0 || item.urgency === URGENCY.P1) {
      sameDay.push({
        item_id: item.item_id,
        urgency: item.urgency,
        child: item.extracted_intake.child_name,
        action: item.recommended_next_action,
      });
    }
  }

  const topMissingFields = Array.from(missingFieldCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([field, count]) => ({ field, count }));

  return {
    total: items.length,
    byUrgency,
    byClassification,
    toolCallCount,
    distinctTools: Array.from(toolNames).sort(),
    topMissingFields,
    escalated,
    sameDay,
  };
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Print the batch summary to stderr. Called from `runAgent` after
 * all items have been triaged.
 */
export async function summariseBatch(items: ItemOutput[]): Promise<void> {
  const stats = computeBatchStats(items);
  const deterministicSummary = formatDeterministicSummary(stats);

  // No key configured -> deterministic only.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(deterministicSummary);
    return;
  }

  // Try the LLM path. On any failure fall back to deterministic.
  try {
    const narrative = await generateLlmSummary(stats, items);
    if (narrative) {
      console.error(formatLlmSummaryBlock(stats, narrative));
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`(LLM summary unavailable: ${msg}; falling back to deterministic.)`);
  }

  console.error(deterministicSummary);
}

// ---------------------------------------------------------------------
// Deterministic formatter
// ---------------------------------------------------------------------

/**
 * Renders the deterministic stats as a compact human-readable block.
 * Always available - this is what reviewers see when no API key is set.
 */
function formatDeterministicSummary(stats: BatchStats): string {
  const lines: string[] = [];
  lines.push("=== Triage summary ===");
  lines.push(
    `Items: ${stats.total}   P0:${stats.byUrgency.P0} P1:${stats.byUrgency.P1} P2:${stats.byUrgency.P2} P3:${stats.byUrgency.P3}`,
  );

  const classes = Object.entries(stats.byClassification)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  lines.push(`Classifications: ${classes}`);

  lines.push(
    `Tools: ${stats.toolCallCount} calls across ${stats.distinctTools.length} distinct (${stats.distinctTools.join(", ")})`,
  );

  if (stats.topMissingFields.length > 0) {
    const missing = stats.topMissingFields
      .map((m) => `${m.field} (${m.count})`)
      .join(", ");
    lines.push(`Top missing intake: ${missing}`);
  }

  if (stats.sameDay.length > 0) {
    lines.push("Same-day attention:");
    for (const sd of stats.sameDay) {
      lines.push(
        `  ${sd.urgency} ${sd.item_id} (${sd.child ?? "unknown child"}): ${sd.action}`,
      );
    }
  }

  if (stats.escalated.length > 0) {
    lines.push("Escalations:");
    for (const esc of stats.escalated) {
      lines.push(`  ${esc.severity} ${esc.item_id}: ${esc.reason}`);
    }
  }

  return lines.join("\n");
}

/**
 * Wraps the LLM-generated narrative with a deterministic counts
 * header so reviewers always see verifiable headline stats even when
 * the prose is generated.
 */
function formatLlmSummaryBlock(stats: BatchStats, narrative: string): string {
  const header: string[] = [];
  header.push("=== Triage summary (LLM-narrated) ===");
  header.push(
    `Items: ${stats.total}   P0:${stats.byUrgency.P0} P1:${stats.byUrgency.P1} P2:${stats.byUrgency.P2} P3:${stats.byUrgency.P3}   Tools: ${stats.toolCallCount}`,
  );
  return `${header.join("\n")}\n\n${narrative.trim()}\n`;
}

// ---------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------

/**
 * Call Claude Haiku to produce a 100-150 word "morning huddle"
 * narrative.
 *
 * Why Haiku: this is a low-latency, low-cost summarisation task -
 * Opus or Sonnet would be overkill.
 *
 * Why a tight prompt: drafts that give clinical advice would be a
 * policy violation, so the system prompt explicitly rules that out
 * and constrains the LLM to the JSON we feed it.
 *
 * Returns null if the response is empty; throws for actual API
 * errors so the caller can log them and fall back.
 */
async function generateLlmSummary(
  stats: BatchStats,
  items: ItemOutput[],
): Promise<string | null> {
  // Dynamic import keeps the no-key path zero-cost - the SDK is
  // only loaded when actually needed.
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Slim view of the items - just the decisions, no raw bodies.
  // Keeps the prompt focused and cost down.
  const itemSummaries = items.map((item) => ({
    item_id: item.item_id,
    classification: item.classification,
    urgency: item.urgency,
    child_name: item.extracted_intake.child_name,
    discipline: item.extracted_intake.discipline,
    payer: item.extracted_intake.payer,
    recommended_next_action: item.recommended_next_action,
    escalation: item.escalation,
  }));

  const systemPrompt = [
    "You are summarising a pediatric therapy practice's Monday morning inbox triage for the front desk and clinical lead.",
    "Write a 100-150 word morning-huddle briefing.",
    "Rules:",
    "- Cite specific item_ids and child names so staff can find them.",
    "- Lead with anything P0 or P1.",
    "- Mention identity issues, out-of-network referrals, or missing paperwork only briefly.",
    "- DO NOT give clinical advice or speculate about diagnoses.",
    "- DO NOT invent items, names, or actions that are not in the JSON.",
    "- Plain English, short sentences. Bullets are fine.",
  ].join("\n");

  const userPrompt = [
    "Here are the triage decisions the agent produced:",
    "",
    JSON.stringify(
      {
        counts: {
          total: stats.total,
          byUrgency: stats.byUrgency,
          byClassification: stats.byClassification,
        },
        items: itemSummaries,
      },
      null,
      2,
    ),
    "",
    "Write the morning huddle summary now.",
  ].join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : null;
}
