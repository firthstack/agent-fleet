import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope for the outbound credentials the gateway uses to call agents
 * (docs §4, `fleet_agent_credentials.secret_enc`).
 *
 * docs §12 leaves KMS-vs-pgcrypto open. This is the local-key implementation:
 * AES-256-GCM with a key supplied out-of-band, which keeps the ciphertext
 * useless to anyone who only has a database dump. `SecretBox` is the seam —
 * a KMS-backed implementation swaps in without touching callers.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface SecretBox {
  seal(plaintext: string): Buffer;
  open(sealed: Buffer): string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export function parseSecretKey(hex: string): Buffer {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new SecretBoxError(
      "secret key must be 64 hex characters (32 bytes); generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(trimmed, "hex");
}

export function createAesSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_LEN) {
    throw new SecretBoxError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      // version || iv || tag || ciphertext — the version byte is what makes a
      // future key rotation or algorithm change decodable.
      return Buffer.concat([
        Buffer.from([VERSION]),
        iv,
        cipher.getAuthTag(),
        body,
      ]);
    },

    open(sealed) {
      if (sealed.length < 1 + IV_LEN + TAG_LEN) {
        throw new SecretBoxError("sealed value is too short");
      }
      if (sealed[0] !== VERSION) {
        throw new SecretBoxError(`unsupported envelope version: ${sealed[0]}`);
      }
      const iv = sealed.subarray(1, 1 + IV_LEN);
      const tag = sealed.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
      const body = sealed.subarray(1 + IV_LEN + TAG_LEN);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        // GCM's tag check failed: wrong key, or the ciphertext was tampered
        // with. Both are the same answer to the caller.
        throw new SecretBoxError("could not decrypt: wrong key or corrupt data");
      }
    },
  };
}

export function fleetSecretBoxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecretBox {
  const raw = env.FLEET_SECRET_KEY?.trim();
  if (!raw) {
    throw new Error(
      "FLEET_SECRET_KEY is required to store agent credentials. " +
        "Generate one with `openssl rand -hex 32` and set it with " +
        "`insta secrets set FLEET_SECRET_KEY <value>`.",
    );
  }
  return createAesSecretBox(parseSecretKey(raw));
}

/** Constant-time compare for token hashes (docs §4). */
export function secureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
