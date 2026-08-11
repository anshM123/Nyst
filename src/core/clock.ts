/**
 * ClockAttestation — an honest statement about where a timestamp came from.
 *
 * Phase 1 only provides `local_system_clock`, which is explicitly NOT a
 * cryptographically trusted time source (`trusted: false`). The abstraction
 * exists so stronger sources (roughtime, TSA/RFC3161, TEE clocks) can be
 * plugged in later without changing consumers.
 */
import { en, obj, str, bool, opt, num, type Schema } from "./validate.js";

export const CLOCK_SOURCES = [
  "local_system_clock",
  // Reserved for the future; no Phase 1 implementation:
  "ntp_disciplined",
  "roughtime",
  "rfc3161_tsa",
] as const;

export type ClockSource = (typeof CLOCK_SOURCES)[number];

export interface ClockAttestation {
  source: ClockSource;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /**
   * Whether this time value is cryptographically attested by an external
   * authority. Always false for local_system_clock.
   */
  trusted: boolean;
  /** Monotonic ordering hint within one process; not wall-clock meaningful. */
  monotonic_ns?: number;
}

export const ClockAttestationSchema: Schema<ClockAttestation> = obj({
  source: en(CLOCK_SOURCES),
  timestamp: str({ min: 20 }),
  trusted: bool(),
  monotonic_ns: opt(num({ min: 0 })),
});

export interface ClockAttestor {
  now(): ClockAttestation;
}

export class LocalSystemClock implements ClockAttestor {
  now(): ClockAttestation {
    return {
      source: "local_system_clock",
      timestamp: new Date().toISOString(),
      trusted: false,
      monotonic_ns: Number(process.hrtime.bigint() % BigInt(Number.MAX_SAFE_INTEGER)),
    };
  }
}

/** Deterministic clock for tests. */
export class FixedClock implements ClockAttestor {
  private tick = 0;
  constructor(private baseIso: string = "2026-01-01T00:00:00.000Z") {}
  now(): ClockAttestation {
    const t = new Date(new Date(this.baseIso).getTime() + this.tick++ * 1000);
    return { source: "local_system_clock", timestamp: t.toISOString(), trusted: false };
  }
}
