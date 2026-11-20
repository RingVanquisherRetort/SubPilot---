import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";

function getEncryptionKey(): Buffer {
  const encodedKey = process.env.SECRETS_ENCRYPTION_KEY;

  if (!encodedKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not configured.");
  }

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return key;
}

/**
 * Encrypts a secret using AES-256-GCM.
 * Stored format: version.iv.authentication-tag.ciphertext (base64url parts).
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty secret.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);

  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

/** Decrypts a value produced by encryptSecret. Authentication failures throw. */
export function decryptSecret(encrypted: string): string {
  const [version, ivPart, tagPart, ciphertextPart, extra] = encrypted.split(".");

  if (
    version !== FORMAT_VERSION ||
    !ivPart ||
    !tagPart ||
    ciphertextPart === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unsupported or malformed encrypted secret.");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Malformed encrypted secret payload.");
  }

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}
