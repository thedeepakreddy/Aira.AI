/**
 * Provider-side metadata that has to survive a tool round trip.
 *
 * Gemini 3 is a thinking model: every function call it emits carries a
 * `thought_signature`, and the next request must hand that signature back
 * alongside the call. Omit it and the API rejects the whole turn with
 *
 *   400 — "Function call is missing a thought_signature in functionCall parts."
 *
 * which is fatal for any agent, since a coding agent is almost entirely tool
 * calls: the first turn succeeds and every turn after it fails.
 *
 * The signature travels in a vendor extension (`extra_content`) that Aira's own
 * tool-call shape has no room for, and clients are under no obligation to echo
 * an unknown field back. Rather than depend on every client preserving it, the
 * gateway remembers it against the tool-call id and re-attaches it on the way
 * out. Tool-call ids are unique per call, so a hit is exact.
 *
 * Bounded and in-memory on purpose. This is a short-lived correlation, not
 * state worth persisting: losing it costs one retry, where an unbounded map
 * would be a leak on a long-running gateway.
 */

/** Roughly a few hundred concurrent agent turns; far past any real session. */
const MAX_ENTRIES = 2_000;

const signatures = new Map<string, unknown>();

export function rememberToolCallMetadata(id: string, metadata: unknown): void {
  if (!id || metadata === undefined || metadata === null) return;
  // Re-inserting moves the key to the end, so eviction stays least-recent-first.
  signatures.delete(id);
  signatures.set(id, metadata);
  while (signatures.size > MAX_ENTRIES) {
    const oldest = signatures.keys().next();
    if (oldest.done) break;
    signatures.delete(oldest.value);
  }
}

export function recallToolCallMetadata(id: string): unknown {
  return id ? signatures.get(id) : undefined;
}

/** Test seam. */
export function clearToolCallMetadata(): void {
  signatures.clear();
}

export function toolCallMetadataSize(): number {
  return signatures.size;
}
