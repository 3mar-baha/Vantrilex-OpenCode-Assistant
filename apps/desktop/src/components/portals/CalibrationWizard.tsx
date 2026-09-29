import { useEffect, useRef, useState } from 'react';
import { AudioCapture } from '../../audio/capture.js';
import {
  GATE_DB,
  QUIET_MARGIN_DB,
  calibrationVerdict,
  type CalibrationBand,
  type CalibrationVerdict,
} from '../../audio/calibration-meter.js';
import { bytesToSamples, frameEnergyDb, micFailureNotice } from '../../audio/vad.js';
import { PortalShell } from './PortalShell.js';

// M4 C.6 — the microphone calibration WIZARD. Three phases over ~10 s:
// listen (0–3 s, a live energy meter), measure (3–8 s, the room floor against
// the shared −30 dB gate) and verdict (8–10 s).
//
// WHY THE PHASES ARE SPLIT THAT WAY. The listen phase answers one question —
// is the microphone actually hot? — and it is also the phase where the user is
// most likely to TALK, which is exactly why its frames are discarded. Mixing
// them into the floor would measure the user instead of the room. The measure
// phase is a quiet period, and only its frames are judged.
//
// WHAT IT DOES NOT DO, and each of these is a decision rather than an omission:
//
//   - IT STORES NOTHING. The floor is shown, not applied. A renderer threshold
//     would only affect barge-in ducking, nobody has measured that, and there
//     is nowhere durable to put a value anyway: no storage API is used
//     anywhere in this tree and the webview exposes no file capability. So
//     there is no save control to render — one that could not work is a false
//     affordance, and copy implying a value was applied would be a lie about a
//     threshold nobody measured.
//   - IT SENDS NOTHING. No command, no socket, no `announce` write, no canned
//     reply. A measurement the user asked for is not a turn, and a spoken
//     sentence about it would be a canned reply in the one place the project
//     has banned them.
//   - IT NEVER CLAIMS A MEASUREMENT IT DID NOT TAKE. Below the meter's
//     `MIN_SAMPLES` the copy says the measurement did not happen and names no
//     number. A floor printed from nothing is worse than no floor.
//
// SHAPE. The panel is portalled to the body by `PortalShell`, which puts it
// outside the auto-sized HUD card, and its content is capped and scrollable
// rather than left to grow: the app surface is 440×600 and auto-sizes to what
// it contains, so a growing in-flow block would resize the app itself.
//
// The clock and the microphone are seams. Production passes the real ones;
// the tests pass a clock they move by hand and a source that emits frames on
// demand, which is what makes a ten-second run decidable in milliseconds.

export const LISTEN_MS = 3000;
export const MEASURE_MS = 5000;
export const VERDICT_MS = 2000;
export const TOTAL_MS = LISTEN_MS + MEASURE_MS + VERDICT_MS;

export type CalibrationPhase = 'listen' | 'measure' | 'verdict' | 'done';

export interface CalibrationClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const DEFAULT_CLOCK: CalibrationClock = {
  now: (): number => Date.now(),
  setTimeout: (fn, ms): number => window.setTimeout(fn, ms),
  clearTimeout: (id): void => window.clearTimeout(id),
};

export interface CalibrationSource {
  start(events: { onFrame(bytes: Uint8Array): void; onError?(err: Error): void }): Promise<void>;
  stop(): void;
}

const DEFAULT_CREATE_SOURCE: () => CalibrationSource = (): CalibrationSource => new AudioCapture();

const PHASE_LABEL_AR: Readonly<Record<CalibrationPhase, string>> = {
  listen: '١. الاستماع — تأكد أن الميكروفون يعمل',
  measure: '٢. القياس — اصمت، نقرأ ضجيج الغرفة فقط',
  verdict: '٣. النتيجة',
  done: '٣. النتيجة',
};

const PHASE_HINT_AR: Readonly<Record<CalibrationPhase, string>> = {
  listen: 'مؤشر الطاقة يبيّن أن الميكروفون يسمع شيئاً. لا يهم ماذا تقول في هذه المرحلة.',
  measure: 'نأخذ أعلى مستوى الضجيج في الغرفة خلال خمس ثوانٍ.',
  verdict: 'هذه قراءة فقط — لم يتغيّر أي إعداد.',
  done: 'يمكنك إعادة المعايرة في أي وقت.',
};

/** Every band names the measured floor. The numbers are interpolated. */
function bandSentenceAr(band: CalibrationBand, floorDb: number): string {
  switch (band) {
    case 'quiet':
      return `أرضية الضوضاء ${floorDb.toFixed(1)} ديسيبل، أي أبعد من عتبة الكلام (${GATE_DB} ديسيبل) بـ${QUIET_MARGIN_DB} ديسيبل. الميكروفون في وضع مريح.`;
    case 'borderline':
      return `أرضية الضوضاء ${floorDb.toFixed(1)} ديسيبل، قريبة من عتبة الكلام (${GATE_DB} ديسيبل). ابتعد قليلاً عن مصدر الضجيج.`;
    case 'noisy':
      return `أرضية الضوضاء ${floorDb.toFixed(1)} ديسيبل، عند عتبة الكلام (${GATE_DB} ديسيبل) أو فوقها — الضجيج وحده قد يفعّل الميكروفون. قلّل ضجيج الغرفة أو قرّب الميكروفون من فمك.`;
  }
}

/** No number, because none was taken. */
const UNMEASURED_AR = 'لم تصل عينة صوتية كافية لقياس أرضية الضوضاء — أعد المعايرة وتأكد من إذن الميكروفون.';

/** Meter scale: the documented -100 dBFS floor to 0 dBFS. */
function meterPercent(db: number): number {
  const pct = ((Math.max(-100, Math.min(0, db)) + 100) / 100) * 100;
  return Math.round(pct);
}

export interface CalibrationWizardProps {
  readonly onClose: () => void;
  readonly clock?: CalibrationClock;
  readonly createSource?: () => CalibrationSource;
}

export function CalibrationWizard({
  onClose,
  clock = DEFAULT_CLOCK,
  createSource = DEFAULT_CREATE_SOURCE,
}: CalibrationWizardProps): JSX.Element {
  const [phase, setPhase] = useState<CalibrationPhase>('listen');
  const [liveDb, setLiveDb] = useState<number | null>(null);
  const [micError, setMicError] = useState('');
  const [verdict, setVerdict] = useState<CalibrationVerdict | null>(null);
  // The frame callback runs between renders, so it reads the phase from a ref
  // rather than closing over a stale copy — the same shape App uses for
  // `speaking`.
  const phaseRef = useRef<CalibrationPhase>('listen');
  const measureRef = useRef<Int16Array[]>([]);
  const lastMeterRef = useRef<number | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const source = createSource();
    let cancelled = false;
    const events = {
      onFrame(bytes: Uint8Array): void {
        const samples = bytesToSamples(bytes);
        const db = frameEnergyDb(samples);
        if (phaseRef.current === 'measure') {
          measureRef.current.push(samples);
          return;
        }
        if (phaseRef.current !== 'listen') return;
        // A meter does not need 300 updates a second, and each one is a render.
        const last = lastMeterRef.current;
        if (last !== null && Math.abs(db - last) < 0.5) return;
        lastMeterRef.current = db;
        setLiveDb(db);
      },
      onError(err: Error): void {
        if (!cancelled) setMicError(micFailureNotice(err));
      },
    };
    void source.start(events).catch((err: unknown) => {
      if (!cancelled) setMicError(micFailureNotice(err));
    });
    return () => {
      cancelled = true;
      // The device is released when the portal closes, whatever happened.
      source.stop();
    };
  }, [createSource]);

  useEffect(() => {
    const toMeasure = clock.setTimeout(() => setPhase('measure'), LISTEN_MS);
    // The verdict is computed HERE, in the transition, rather than during
    // render: reading the collected frames out of a ref while rendering is a
    // side-channel React has no reason to trust.
    const toVerdict = clock.setTimeout(() => {
      setVerdict(calibrationVerdict(measureRef.current));
      setPhase('verdict');
    }, LISTEN_MS + MEASURE_MS);
    const toDone = clock.setTimeout(() => setPhase('done'), TOTAL_MS);
    return () => {
      clock.clearTimeout(toMeasure);
      clock.clearTimeout(toVerdict);
      clock.clearTimeout(toDone);
    };
  }, [clock]);

  const band = verdict?.band;
  const floorDb = verdict?.floorDb ?? null;
  const showingVerdict = phase === 'verdict' || phase === 'done';

  return (
    <PortalShell label="معايرة الميكروفون" onClose={onClose}>
      <div
        data-testid="calibration-portal"
        data-phase={phase}
        {...(band !== undefined ? { 'data-band': band } : {})}
        dir="rtl"
        className="voxaura-portal flex flex-col gap-3 p-4 text-[#f4f4f5]"
        style={{ fontFamily: 'var(--vx-font)' }}
      >
        <header className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">معايرة الميكروفون</h2>
          <span className="vx-kbd ms-auto" title="إغلاق المعايرة">
            Esc
          </span>
        </header>

        <div
          data-testid="calibration-body"
          className="flex max-h-[360px] w-[420px] flex-col gap-3 overflow-y-auto"
          // The cap is inline as well as a class: the class is what the real
          // renderer compiles, the inline value is what a test can read as a
          // RESOLVED style (a DOM test environment has no layout engine, so
          // scrollHeight is always 0 there).
          style={{ maxHeight: 360, width: 420 }}
        >
          <ol className="flex items-center gap-1" aria-label="مراحل المعايرة">
            {(['listen', 'measure', 'verdict'] as const).map((step, i) => {
              const order = ['listen', 'measure', 'verdict'];
              const done = order.indexOf(phase) >= i;
              return (
                <li
                  key={step}
                  data-step={step}
                  aria-current={phase === step ? 'step' : undefined}
                  title={PHASE_LABEL_AR[step]}
                  className={`h-1 flex-1 rounded-full ${done ? 'bg-[#2563eb]' : 'bg-[#26282e]'}`}
                />
              );
            })}
          </ol>

          <p
            data-testid="calibration-phase-label"
            role="status"
            aria-live="polite"
            title={PHASE_HINT_AR[phase]}
            className="text-xs text-[#f4f4f5]"
          >
            {PHASE_LABEL_AR[phase]}
          </p>

          {phase === 'listen' && (
            <div className="flex flex-col gap-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-[#0e0f12]">
                <div
                  data-testid="calibration-energy"
                  data-db={liveDb === null ? '' : liveDb.toFixed(1)}
                  title="طاقة صوت الميكروفون الآن"
                  className="h-full bg-[#34d399]"
                  style={{ width: `${liveDb === null ? 0 : meterPercent(liveDb)}%` }}
                />
              </div>
              <span className="vx-mono-metric text-[10px] text-[#a1a1aa]">
                {liveDb === null ? 'بانتظار الصوت…' : `${liveDb.toFixed(1)} ديسيبل`}
              </span>
            </div>
          )}

          {phase === 'measure' && (
            <p data-testid="calibration-measuring" className="text-[11px] text-[#a1a1aa]">
              {PHASE_HINT_AR.measure}
            </p>
          )}

          {micError.length > 0 && (
            <p data-testid="calibration-mic-error" role="alert" className="text-[11px] text-[#f87171]">
              {micError}
            </p>
          )}

          {showingVerdict && verdict !== null && (
            <p
              data-testid="calibration-verdict"
              data-measured={String(verdict.measured)}
              data-floor-db={floorDb === null ? '' : String(floorDb)}
              title={
                verdict.measured && floorDb !== null
                  ? `${bandSentenceAr(verdict.band, floorDb)} — عتبة الكلام ${GATE_DB} ديسيبل`
                  : UNMEASURED_AR
              }
              className={`text-xs ${band === 'quiet' ? 'text-[#34d399]' : band === 'borderline' ? 'text-[#fbbf24]' : 'text-[#f87171]'}`}
            >
              {verdict.measured && floorDb !== null
                ? bandSentenceAr(verdict.band, floorDb)
                : UNMEASURED_AR}
            </p>
          )}

          {/* Pinned verbatim by the test: copy that implied the reading had
              been applied would claim a threshold nobody measured. */}
          <p data-testid="calibration-advice-only" className="text-[10px] text-[#71717a]">
            قياس فقط — لم تُحفظ أي عتبة ولم يتغيّر أي إعداد.
          </p>
        </div>

        <button
          data-testid="calibration-close"
          type="button"
          title="إغلاق المعايرة"
          onClick={onClose}
          className="self-start rounded-[6px] border border-[#26282e] px-3 py-1 text-xs text-[#a1a1aa] hover:text-[#f4f4f5]"
        >
          إغلاق
        </button>
      </div>
    </PortalShell>
  );
}
