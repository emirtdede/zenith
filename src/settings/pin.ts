/**
 * PIN and password storage.
 *
 * The lock screen protects the app, not the machine: an attacker with the disk
 * can replace the binary, so the honest goal is to stop a shoulder-surfer and
 * a borrowed laptop, and to make an offline guess expensive. That means a slow
 * memory-hard KDF and a per-record salt, never a hash of the digits.
 *
 * WebCrypto ships PBKDF2 in every WebView2 runtime; Argon2 needs WASM (a 200 KB
 * download and a CSP exception) and the security difference for a 4-8 digit PIN
 * is close to nothing because the keyspace is tiny. PBKDF2-HMAC-SHA256 at
 * 600,000 iterations costs about a third of a second here, which is enough to
 * make the unlock feel deliberate without being annoying, and it is the
 * strongest option available without shipping a second crypto stack. The record
 * names the algorithm, so a future build can migrate without guessing.
 *
 * The attempt counter and the lock date live in the same record. A lockout that
 * only the UI remembers is a lockout that a reload clears.
 */

export const PBKDF2_ITERATIONS = 600_000;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 5;
/** Digits allowed by the setup screen, and by the keypad it draws. */
export const PIN_LENGTHS = [4, 6, 8] as const;

export interface PinRecord {
  kind: "pin" | "password";
  digits: 4 | 6 | 8 | 0;
  algorithm: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  hashB64: string;
  createdAtUtc: string;
  failedAttempts: number;
  lockedUntilUtc: string | null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("WebCrypto is unavailable; a PIN cannot be stored safely in this runtime.");
  }
  return crypto.subtle;
}

async function derive(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Constant-time comparison, so a wrong PIN leaks nothing through timing. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

export function digitsOf(kind: "pin" | "password", length: number): 4 | 6 | 8 | 0 {
  if (kind === "password") {
    return 0;
  }
  return length === 4 || length === 6 || length === 8 ? length : 4;
}

/** A record is only usable if it names a KDF we can compute. */
export function isPinRecord(value: unknown): value is PinRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "pin" || record.kind === "password") &&
    record.algorithm === "PBKDF2-SHA256" &&
    typeof record.saltB64 === "string" &&
    record.saltB64.length > 0 &&
    typeof record.hashB64 === "string" &&
    record.hashB64.length > 0 &&
    typeof record.iterations === "number" &&
    record.iterations >= 100_000
  );
}

export async function createPinRecord(
  secret: string,
  kind: "pin" | "password",
  length: number,
): Promise<PinRecord> {
  if (kind === "pin") {
    if (!/^[0-9]+$/.test(secret) || !(PIN_LENGTHS as readonly number[]).includes(secret.length)) {
      throw new Error("A PIN must be 4, 6 or 8 digits.");
    }
  } else if (secret.length < 10 || !/[0-9]/.test(secret) || !/[A-Za-z]/.test(secret)) {
    throw new Error("A password must be at least 10 characters and contain a letter and a digit.");
  }
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const iterations = PBKDF2_ITERATIONS;
  const hash = await derive(secret, salt, iterations);
  return {
    kind,
    digits: digitsOf(kind, length),
    algorithm: "PBKDF2-SHA256",
    iterations,
    saltB64: toBase64(salt),
    hashB64: toBase64(hash),
    createdAtUtc: new Date().toISOString(),
    failedAttempts: 0,
    lockedUntilUtc: null,
  };
}

export function lockedRemainingMs(record: PinRecord | null, now = Date.now()): number {
  if (!record?.lockedUntilUtc) {
    return 0;
  }
  const until = new Date(record.lockedUntilUtc).getTime();
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}

export interface VerifyResult {
  ok: boolean;
  /** The record to persist: attempts advanced, or the lock set. */
  record: PinRecord;
  remainingAttempts: number;
  lockedUntilUtc: string | null;
}

/**
 * Verify a secret and return the next record.
 *
 * The caller persists the returned record even when the attempt fails, because
 * the lockout is a property of the record, not of the component. A correct
 * secret clears both the counter and any stale lock.
 */
export async function verifyPin(
  secret: string,
  record: PinRecord,
  now = new Date(),
): Promise<VerifyResult> {
  const remaining = lockedRemainingMs(record, now.getTime());
  if (remaining > 0) {
    return {
      ok: false,
      record,
      remainingAttempts: 0,
      lockedUntilUtc: record.lockedUntilUtc,
    };
  }

  let matches = false;
  try {
    const hash = await derive(secret, fromBase64(record.saltB64), record.iterations);
    matches = equalBytes(hash, fromBase64(record.hashB64));
  } catch {
    matches = false;
  }

  if (matches) {
    return {
      ok: true,
      record: { ...record, failedAttempts: 0, lockedUntilUtc: null },
      remainingAttempts: MAX_ATTEMPTS,
      lockedUntilUtc: null,
    };
  }

  const attempts = record.failedAttempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const until = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString();
    return {
      ok: false,
      record: { ...record, failedAttempts: 0, lockedUntilUtc: until },
      remainingAttempts: MAX_ATTEMPTS,
      lockedUntilUtc: until,
    };
  }

  return {
    ok: false,
    record: { ...record, failedAttempts: attempts },
    remainingAttempts: MAX_ATTEMPTS - attempts,
    lockedUntilUtc: null,
  };
}

/** A rough meter for the setup screen. Length dominates, as it should. */
export function passwordScore(secret: string): 0 | 1 | 2 | 3 | 4 {
  if (!secret) {
    return 0;
  }
  let score = 0;
  if (secret.length >= 10) {
    score += 1;
  }
  if (secret.length >= 14) {
    score += 1;
  }
  if (/[a-z]/.test(secret) && /[A-Z]/.test(secret)) {
    score += 1;
  }
  if (/[0-9]/.test(secret) && /[^A-Za-z0-9]/.test(secret)) {
    score += 1;
  }
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
}
