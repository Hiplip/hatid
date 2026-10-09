import type { HatidErrorCode } from "../../src/core/errors";

const RETRYABLE = new Set(["RATE_LIMITED", "HOOK_FAILED", "STORAGE", "NETWORK", "CANCELED"]);

/**
 * Simulates a HatidError created by a second copy of the class (another dist bundle):
 * not an instance of this copy's class, but carrying the shared brand.
 */
export function foreignHatidError(code: HatidErrorCode, message = code) {
  return Object.assign(new Error(message), {
    name: "HatidError", code, status: 0, retryable: RETRYABLE.has(code), retryAfter: undefined,
    [Symbol.for("@hiplip/hatid/error")]: true,
    toWire: () => ({ code, message }),
  });
}
