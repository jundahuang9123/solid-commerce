/**
 * Wallet descriptor in the Pod: which payment schemes the user can pay with,
 * and public payer identifiers. It holds NO keys, tokens or card data; those
 * stay in the signer.
 */
import N3 from "n3";
import { NS, sc } from "../rdf/namespaces.js";
import type { SchemeId } from "../model.js";
import { SCHEME_IRI_NAME } from "../model.js";
import { PodClient } from "./PodClient.js";

export interface WalletDescriptor { schemes: SchemeId[]; x402Address?: string; signerEndpoint: string }

export function walletToTurtle(url: string, w: WalletDescriptor): string {
  return `@prefix sc: <${NS.sc}> .
<${url}#wallet> a sc:WalletDescriptor ;
  sc:signerEndpoint <${w.signerEndpoint}> ;
${w.x402Address ? `  sc:x402Payer "${w.x402Address}" ;\n` : ""}  sc:paymentScheme ${w.schemes.map((s) => `sc:${SCHEME_IRI_NAME[s]}`).join(", ")} .
`;
}

export async function readWallet(pod: PodClient, url: string): Promise<WalletDescriptor> {
  const res = await pod.get(url);
  if (!res) throw new Error(`No wallet descriptor at ${url}`);
  const st = new N3.Store(new N3.Parser({ baseIRI: url }).parse(res.text));
  const s = N3.DataFactory.namedNode(url + "#wallet");
  const objs = (p: string) => st.getObjects(s, N3.DataFactory.namedNode(p), null).map((t) => t.value);
  const byName = Object.fromEntries(Object.entries(SCHEME_IRI_NAME).map(([k, v]) => [sc(v), k as SchemeId]));
  return { schemes: objs(sc("paymentScheme")).map((x) => byName[x]).filter(Boolean), x402Address: objs(sc("x402Payer"))[0], signerEndpoint: objs(sc("signerEndpoint"))[0] };
}
