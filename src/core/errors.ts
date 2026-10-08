export type HatidErrorCode =
  | "CONFIG" | "INVALID_INPUT" | "FILE_TOO_LARGE" | "INVALID_TYPE" | "UNAUTHORIZED"
  | "RATE_LIMITED" | "CONFIRM_REJECTED" | "UPLOAD_INVALID" | "HOOK_FAILED" | "STORAGE"
  | "INTERNAL" | "TOO_MANY_FILES" | "NETWORK" | "CANCELED";

const TABLE: Record<HatidErrorCode, { status: number; retryable: boolean }> = {
  CONFIG: { status: 500, retryable: false },
  INVALID_INPUT: { status: 400, retryable: false },
  FILE_TOO_LARGE: { status: 413, retryable: false },
  INVALID_TYPE: { status: 415, retryable: false },
  UNAUTHORIZED: { status: 401, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  CONFIRM_REJECTED: { status: 404, retryable: false },
  UPLOAD_INVALID: { status: 422, retryable: false },
  HOOK_FAILED: { status: 500, retryable: true },
  STORAGE: { status: 502, retryable: true },
  INTERNAL: { status: 500, retryable: false },
  // client-only codes
  TOO_MANY_FILES: { status: 400, retryable: false },
  NETWORK: { status: 0, retryable: true },
  CANCELED: { status: 0, retryable: true },
};

const GENERIC: Partial<Record<HatidErrorCode, string>> = {
  CONFIG: "Server misconfiguration.",
  STORAGE: "Storage request failed. Please retry.",
  HOOK_FAILED: "Could not save the upload. Please retry.",
  INTERNAL: "Internal error.",
};

export type WireError = { code: HatidErrorCode; message: string; retryAfter?: number };

export class HatidError extends Error {
  override readonly name = "HatidError";
  readonly code: HatidErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: number | undefined;

  constructor(code: HatidErrorCode, message: string, options: { retryAfter?: number | undefined; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = TABLE[code].status;
    this.retryable = TABLE[code].retryable;
    this.retryAfter = options.retryAfter;
  }

  toWire(): WireError {
    const message = GENERIC[this.code] ?? this.message;
    return this.retryAfter === undefined ? { code: this.code, message } : { code: this.code, message, retryAfter: this.retryAfter };
  }
}

export function isHatidError(e: unknown): e is HatidError {
  return e instanceof HatidError;
}

export function toHatidError(e: unknown): HatidError {
  if (isHatidError(e)) return e;
  return new HatidError("INTERNAL", e instanceof Error ? e.message : String(e), { cause: e });
}

const CODES = new Set<string>(Object.keys(TABLE));

export function fromWire(body: unknown, status: number): HatidError {
  const err = typeof body === "object" && body !== null ? (body as { error?: Partial<WireError> }).error : undefined;
  if (err && typeof err.code === "string" && CODES.has(err.code)) {
    return new HatidError(err.code, typeof err.message === "string" ? err.message : err.code,
      typeof err.retryAfter === "number" ? { retryAfter: err.retryAfter } : {});
  }
  return new HatidError(status >= 500 ? "STORAGE" : "INTERNAL", `Unexpected response (HTTP ${status})`);
}
