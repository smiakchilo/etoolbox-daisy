/**
 * Single, greppable marker for every control in this step whose real
 * behaviour depends on a main-process/preload capability that does not exist
 * yet (implementation-plan.md step 05 is renderer-only for this agent; the
 * corresponding main-process work - window creation, browser navigation,
 * settings mutation - lands separately). Every call site names the missing
 * channel so it is trivial to find and wire up once that channel exists.
 */
export function reportNotWired(feature: string): void {
  console.warn(`[etoolbox-daisy] not wired yet: ${feature}`);
}
