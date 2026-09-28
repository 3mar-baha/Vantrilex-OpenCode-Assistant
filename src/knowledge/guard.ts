import { normalizeArabic } from './normalize.js';

// Tier-D moral guardrail (G4D): deterministic pre-filter + neural backstop.
// The blocklist is INJECTED (Tier-D corpora live outside the repo); matching
// runs on the normalized form so tashkeel/tatweel evasion collapses first.
//
// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/, verbatim.
// REFUSAL_AR is Jordanian and matches the locked dialect: natural Ammani, not
// newsreader MSA, and not Beirusi.
export const REFUSAL_AR = 'هالموضوع ما بناسبنا نناقشه، خلينا مركزين بشغلنا المفيد';

export interface GuardVerdict {
  readonly blocked: boolean;
  readonly reason?: 'blocklist' | 'neural';
}

/** Deterministic pass: true when no blocklist phrase survives normalization. */
export function screenText(text: string, blocklist: readonly string[]): GuardVerdict {
  const normalized = normalizeArabic(text);
  const normalizedList = blocklist.map((entry) => normalizeArabic(entry)).filter((e) => e.length > 0);
  for (const entry of normalizedList) {
    if (normalized.includes(entry)) return { blocked: true, reason: 'blocklist' };
  }
  return { blocked: false };
}

/**
 * Full gate: deterministic screen first (0 ms), then the injected neural
 * check (A.R.E.E.B./Laya isDestructive). Either veto blocks with refusal.
 */
export async function guardText(
  text: string,
  blocklist: readonly string[],
  isDestructive: (text: string) => Promise<boolean>,
): Promise<GuardVerdict> {
  const screened = screenText(text, blocklist);
  if (screened.blocked) return screened;
  try {
    if (await isDestructive(text)) return { blocked: true, reason: 'neural' };
  } catch {
    return { blocked: false }; // neural failure never blocks speech by itself
  }
  return { blocked: false };
}
