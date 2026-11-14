import {
  createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID,
  sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, no whitespace. Used for everything we sign. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  if (typeof v === "bigint") return v.toString();
  return v;
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const digestOf = (value: unknown) => "sha-256:" + sha256Hex(canonicalJson(value));
export const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string) => Buffer.from(s, "base64url");
export const newId = (prefix = "") => prefix + randomUUID();
export const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

export function hmac(key: string | Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Ed25519 key pair with a stable key id. Private keys never leave the object that created them. */
export class Ed25519Key {
  readonly keyId: string;
  private constructor(private readonly priv: KeyObject, readonly publicJwk: JsonWebKey) {
    this.keyId = "ed25519:" + sha256Hex(canonicalJson(publicJwk)).slice(0, 16);
  }
  static generate(): Ed25519Key {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new Ed25519Key(privateKey, publicKey.export({ format: "jwk" }));
  }
  static fromPrivateJwk(jwk: JsonWebKey): Ed25519Key {
    const priv = createPrivateKey({ key: jwk as any, format: "jwk" });
    return new Ed25519Key(priv, createPublicKey(priv).export({ format: "jwk" }));
  }
  signJson(value: unknown): string {
    return b64u(edSign(null, Buffer.from(canonicalJson(value)), this.priv));
  }
}

export function verifyJsonSignature(value: unknown, signature: string, publicJwk: JsonWebKey): boolean {
  try {
    const pub = createPublicKey({ key: publicJwk as any, format: "jwk" });
    return edVerify(null, Buffer.from(canonicalJson(value)), pub, fromB64u(signature));
  } catch {
    return false;
  }
}
export const keyIdOf = (publicJwk: JsonWebKey) => "ed25519:" + sha256Hex(canonicalJson(publicJwk)).slice(0, 16);

/** A detached-signature envelope: { payload, sig: { keyId, alg, value } }. */
export interface Signed<T> { payload: T; sig: { keyId: string; alg: "Ed25519"; value: string } }
export function signEnvelope<T>(key: Ed25519Key, payload: T): Signed<T> {
  return { payload, sig: { keyId: key.keyId, alg: "Ed25519", value: key.signJson(payload) } };
}
export function verifyEnvelope<T>(env: Signed<T>, publicJwk: JsonWebKey): boolean {
  return env?.sig?.alg === "Ed25519" && env.sig.keyId === keyIdOf(publicJwk) && verifyJsonSignature(env.payload, env.sig.value, publicJwk);
}
