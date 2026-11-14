/**
 * Where things live in the buyer's Pod. Private keys and payment credentials
 * are never stored here: they live in the signer (src/signer).
 *
 *   <pod>/profile/card                       WebID profile
 *   <pod>/commerce/common-ground/<slug>.ttl  agreed meanings (current revision)
 *   <pod>/commerce/preferences/<slug>.ttl    preferences and requirements
 *   <pod>/commerce/mandates/<slug>.ttl       spending mandates (user-signed ODRL)
 *   <pod>/commerce/proposals/<id>.ttl        agent proposals awaiting user approval
 *   <pod>/commerce/history/<slug>-r<n>.ttl   superseded revisions
 *   <pod>/commerce/intentions/<id>.ttl       purchase intentions
 *   <pod>/commerce/transactions/<id>.ttl     offers considered, authorization, receipt, delivery
 *   <pod>/commerce/wallet.ttl                wallet descriptor (schemes, signer endpoint), no secrets
 */
import { NS } from "../rdf/namespaces.js";

export class PodLayout {
  readonly commerce: string;
  constructor(readonly podRoot: string) {
    if (!podRoot.endsWith("/")) throw new Error("podRoot must end with /");
    this.commerce = podRoot + "commerce/";
  }
  get webId() { return this.podRoot + "profile/card#me"; }
  get profile() { return this.podRoot + "profile/card"; }
  get commonGround() { return this.commerce + "common-ground/"; }
  get preferences() { return this.commerce + "preferences/"; }
  get mandates() { return this.commerce + "mandates/"; }
  get proposals() { return this.commerce + "proposals/"; }
  get history() { return this.commerce + "history/"; }
  get intentions() { return this.commerce + "intentions/"; }
  get transactions() { return this.commerce + "transactions/"; }
  get wallet() { return this.commerce + "wallet.ttl"; }

  meaning(slug: string) { return `${this.commonGround}${slug}.ttl#it`; }
  preference(slug: string) { return `${this.preferences}${slug}.ttl#it`; }
  mandate(slug: string) { return `${this.mandates}${slug}.ttl#it`; }
  historyDoc(slug: string, revision: number) { return `${this.history}${slug}-r${revision}.ttl`; }
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Web Access Control documents expressing the intended access policy.
 * The agent can read grounding data and write intentions, proposals and
 * transaction evidence. It cannot write confirmed records or mandates. Even if
 * the ACLs are misconfigured, the gateway still rejects mandates that lack a
 * valid user signature.
 */
export function buildAcls(layout: PodLayout, agentWebIds: string[], gatewayWebId: string): Record<string, string> {
  const owner = layout.webId;
  const rule = (name: string, target: string, agents: string[], modes: string[], isDefault = true) => `
<#${name}> a acl:Authorization ;
  acl:accessTo <${target}> ;${isDefault ? `\n  acl:default <${target}> ;` : ""}
  acl:agent ${agents.map((a) => `<${a}>`).join(", ")} ;
  acl:mode ${modes.map((m) => "acl:" + m).join(", ")} .`;
  const head = `@prefix acl: <${NS.acl}> .\n`;
  const ownerRule = (t: string) => rule("owner", t, [owner], ["Read", "Write", "Control"]);
  return {
    [layout.commonGround + ".acl"]: head + ownerRule(layout.commonGround) + rule("agents", layout.commonGround, agentWebIds, ["Read"]),
    [layout.preferences + ".acl"]: head + ownerRule(layout.preferences) + rule("agents", layout.preferences, agentWebIds, ["Read"]),
    [layout.mandates + ".acl"]: head + ownerRule(layout.mandates) + rule("readers", layout.mandates, [...agentWebIds, gatewayWebId], ["Read"]),
    [layout.proposals + ".acl"]: head + ownerRule(layout.proposals) + rule("agents", layout.proposals, agentWebIds, ["Read", "Append"]),
    [layout.intentions + ".acl"]: head + ownerRule(layout.intentions) + rule("agents", layout.intentions, agentWebIds, ["Read", "Write"]),
    [layout.transactions + ".acl"]: head + ownerRule(layout.transactions) + rule("writers", layout.transactions, [...agentWebIds, gatewayWebId], ["Read", "Write"]),
  };
}
