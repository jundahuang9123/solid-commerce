/**
 * Loading the proxy's key material for a real deployment.
 *
 * Secrets are read from an environment variable or a file, never from the
 * config file itself, so a config can be committed without leaking keys.
 * Anything missing is generated for this process only, with a warning that
 * says exactly what breaks because of it.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Ed25519Key, randomHex } from "../util/crypto.js";

/** Where to find one secret. The environment variable wins over the file. */
export interface SecretSource { env?: string; file?: string }
export interface KeySources { signingJwk?: SecretSource; payTo?: SecretSource; macaroonRootKey?: SecretSource }
export interface KeyMaterial { signingKey: Ed25519Key; payTo: string; macaroonRootKey: string; warnings: string[] }

async function read(src: SecretSource | undefined, baseDir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (src?.env && env[src.env]?.trim()) return env[src.env]!.trim();
  if (src?.file) {
    try { return (await readFile(resolve(baseDir, src.file), "utf8")).trim(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return undefined;
}

export async function loadKeyMaterial(sources: KeySources = {}, baseDir = process.cwd(), env = process.env): Promise<KeyMaterial> {
  const warnings: string[] = [];

  let signingKey: Ed25519Key;
  const jwkText = await read(sources.signingJwk, baseDir, env);
  if (jwkText) {
    const jwk = JSON.parse(jwkText) as JsonWebKey;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) throw new Error("signing key must be an Ed25519 private JWK (kty OKP, crv Ed25519, with d)");
    signingKey = Ed25519Key.fromPrivateJwk(jwk);
  } else {
    signingKey = Ed25519Key.generate();
    warnings.push(
      `No offer-signing key configured: generated an EPHEMERAL Ed25519 key (${signingKey.keyId}).\n` +
      `  Buyers who pin this seller's key must re-pin after every restart. Public JWK:\n  ${JSON.stringify(signingKey.publicJwk)}`,
    );
  }

  let payTo: string;
  const addr = await read(sources.payTo, baseDir, env);
  if (addr) payTo = getAddress(addr);
  else {
    payTo = privateKeyToAccount(generatePrivateKey()).address;
    warnings.push(`No x402 payTo address configured: using EPHEMERAL address ${payTo} whose private key is discarded. Funds sent there are unrecoverable; use only with simulated rails.`);
  }

  let macaroonRootKey = await read(sources.macaroonRootKey, baseDir, env);
  if (macaroonRootKey && !/^[0-9a-f]{64,}$/i.test(macaroonRootKey)) throw new Error("macaroon root key must be at least 32 bytes of hex");
  if (!macaroonRootKey) {
    macaroonRootKey = randomHex(32);
    warnings.push("No L402 macaroon root key configured: generated an EPHEMERAL one. L402 tokens issued before a restart, paid or not, stop working after it.");
  }
  return { signingKey, payTo, macaroonRootKey, warnings };
}
