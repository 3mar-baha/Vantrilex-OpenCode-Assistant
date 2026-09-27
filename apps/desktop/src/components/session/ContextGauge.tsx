// Phase 4 — context-window gauge.
//
// Two rules drive the design:
//   1. Never show a bar without a known denominator. When the model's context
//      window is unknown we render the token count and say the limit is
//      unknown, because a gauge that invents its own maximum misleads.
//   2. Only render for the ACTIVE session. A frame that arrives just after a
//      session switch would otherwise label the new session with the old one's
//      numbers — the classic stale-frame lie.

export interface ContextGaugeProps {
  readonly sessionId?: string;
  readonly activeSessionId?: string;
  readonly used?: number;
  readonly limit?: number | null;
  readonly percent?: number | null;
}

/** Arabic-locale compact token counts (Intl is unreliable in the test DOM). */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${trim(n / 1_000_000)} مليون`;
  if (n >= 1_000) return `${trim(n / 1000)} ألف`;
  return String(Math.round(n));
}

function trim(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

function level(percent: number): 'low' | 'mid' | 'high' {
  if (percent >= 85) return 'high';
  if (percent >= 70) return 'mid';
  return 'low';
}

export function ContextGauge({
  sessionId,
  activeSessionId,
  used,
  limit = null,
  percent = null,
}: ContextGaugeProps): JSX.Element | null {
  if (used === undefined) return null;
  if (sessionId !== undefined && activeSessionId !== undefined && sessionId !== activeSessionId) return null;

  const unknown = percent === null || limit === null;
  const clamped = unknown ? 0 : Math.max(0, Math.min(100, percent));
  const lvl = unknown ? 'low' : level(clamped);

  return (
    <div
      data-testid="context-gauge"
      data-percent={unknown ? 'unknown' : String(clamped)}
      data-level={lvl}
      title={unknown ? 'استهلاك السياق — الحد غير معروف' : 'استهلاك نافذة السياق'}
      className="flex items-center gap-1.5 text-[10px] leading-none text-slate-400"
    >
      <span aria-hidden="true">{formatTokens(used)} رمز</span>
      {unknown ? (
        <span className="text-slate-500">· الحد غير معروف</span>
      ) : (
        <>
          <span
            data-testid="context-bar"
            data-width={String(clamped)}
            className={`h-1 w-10 overflow-hidden rounded-full bg-slate-700 ${
              lvl === 'high' ? 'text-amber-400' : lvl === 'mid' ? 'text-sky-400' : 'text-slate-300'
            }`}
          >
            <span className="block h-full bg-current" style={{ width: `${clamped}%` }} />
          </span>
          <span>{`${trim(clamped)}%`}</span>
        </>
      )}
    </div>
  );
}
