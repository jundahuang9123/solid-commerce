/**
 * Caller authentication for the gateway and the signer.
 *
 * Each agent is enrolled at setup with its own random bearer secret. The
 * gateway and the signer store only the secret's SHA-256, never the secret,
 * and the secret is never written to the Pod: the agent receives it from
 * whoever runs the setup (src/demo/environment.ts) and keeps it in memory.
 * A request is attributed to the agent whose secret it carries, never to the
 * `agentId` string in its body; a body that names another agent is refused.
 *
 * An optional admin secret lets an operator (the demo dashboard) read any
 * transaction and trigger reconciliation. It cannot authorize or pay.
 *
 * Residual risk, stated plainly: these are bearer secrets over plain HTTP on
 * the loopback interface. Anyone who can read the agent's memory or sniff the
 * local traffic can replay one until it is rotated, and there is no rotation,
 * expiry or revocation beyond restarting the services. A deployment would use
 * mTLS or per-request signatures (e.g. HTTP Message Signatures with an
 * Ed25519 key per agent) over TLS, and a key store the agent cannot export from.
 */
import type { IncomingHttpHeaders } from "node:http";
import { randomHex, sha256Hex } from "../util/crypto.js";

export type Principal = { kind: "agent"; agentId: string } | { kind: "admin" };

/** A fresh bearer secret (256 bits). Hand it to exactly one agent. */
export const newAgentSecret = () => "sca_" + randomHex(32);
/** What the services store for a secret. */
export const secretHash = (secret: string) => sha256Hex(`solid-commerce-agent-secret:${secret}`);
/** The header an agent sends to the gateway and the signer. */
export const bearerHeaders = (secret: string | undefined): Record<string, string> => (secret ? { authorization: `Bearer ${secret}` } : {});

export interface AgentEnrollment { agentId: string; secretHash: string }

export class AgentDirectory {
  private readonly byHash = new Map<string, string>();
  private adminHash?: string;

  constructor(agents: AgentEnrollment[] = [], adminSecretHash?: string) {
    for (const a of agents) this.enroll(a.agentId, a.secretHash);
    this.adminHash = adminSecretHash;
  }

  /** Enroll (or add a further secret for) an agent. A secret can belong to one agent only. */
  enroll(agentId: string, hash: string) {
    if (!agentId || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("agent enrollment needs an agent id and a SHA-256 secret hash");
    const prior = this.byHash.get(hash);
    if (prior && prior !== agentId) throw new Error("this secret is already enrolled for another agent");
    if (hash === this.adminHash) throw new Error("the admin secret cannot be an agent secret");
    this.byHash.set(hash, agentId);
  }

  /** Who is calling, from the Authorization header; undefined if no enrolled secret is presented. */
  authenticate(headers: IncomingHttpHeaders): Principal | undefined {
    const m = String(headers.authorization ?? "").match(/^Bearer\s+(\S+)$/i);
    if (!m) return undefined;
    const h = secretHash(m[1]);
    if (this.adminHash && h === this.adminHash) return { kind: "admin" };
    const agentId = this.byHash.get(h);
    return agentId ? { kind: "agent", agentId } : undefined;
  }
}
