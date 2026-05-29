/**
 * Safe tool-call wrapper.
 *
 * Every tool call in the agent goes through `safeCall`. If the tool
 * throws, the failure is captured into the per-item errors array
 * instead of crashing the batch. The handler can then decide whether
 * to skip downstream steps, switch to a fallback flow, or note the
 * failure in `decision_rationale` (the `triageItem` orchestrator
 * folds the errors into the rationale automatically).
 */

import type { ToolResult } from "../types.js";

/**
 * Wrap a tool invocation with graceful error capture.
 *
 * @param label  Human-readable label used in the error message
 *               (the trace already has the args, so this just needs
 *               to be scannable).
 * @param fn     A thunk that calls the actual tool. Wrapped so we
 *               only invoke after we know we want to run it.
 * @param errors Mutable list that the handler accumulates and that
 *               `triageItem` later folds into `decision_rationale`.
 * @returns The tool's ToolResult on success, or null on failure.
 *          The handler must handle the null case explicitly so
 *          downstream logic doesn't accidentally cascade nulls.
 */
export async function safeCall<T>(
  label: string,
  fn: () => Promise<ToolResult<T>>,
  errors: string[],
): Promise<ToolResult<T> | null> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${label} failed: ${msg}`);
    return null;
  }
}
