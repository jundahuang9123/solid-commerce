/**
 * The buyer's shipping address, kept in the Pod as a schema:PostalAddress.
 *
 * It is personal data, so the checkout adapter sends it to ONE merchant: the
 * one it is about to pay, after the merchant has been chosen from feed data
 * alone. The gateway reads the same document to check that a checkout it
 * authorizes ships to this address and not one an agent substituted.
 */
import N3 from "n3";
import { NS } from "../rdf/namespaces.js";
import type { AcpAddress } from "../checkout/acp.js";
import { PodClient } from "./PodClient.js";

export interface PostalAddress { name: string; streetAddress: string; extendedAddress?: string; locality: string; region?: string; postalCode: string; country: string }

const FIELDS: Array<[keyof PostalAddress, string]> = [
  ["name", "name"], ["streetAddress", "streetAddress"], ["extendedAddress", "extendedAddress"], ["locality", "addressLocality"],
  ["region", "addressRegion"], ["postalCode", "postalCode"], ["country", "addressCountry"],
];

export function addressToTurtle(id: string, a: PostalAddress): string {
  const props = FIELDS.filter(([k]) => a[k] !== undefined).map(([k, p]) => `  schema:${p} ${JSON.stringify(a[k])}`);
  return `@prefix schema: <${NS.schema}> .\n<${id}> a schema:PostalAddress ;\n${props.join(" ;\n")} .\n`;
}

export async function readAddress(pod: PodClient, id: string): Promise<PostalAddress | undefined> {
  const doc = id.split("#")[0];
  const res = await pod.get(doc);
  if (!res) return undefined;
  const st = new N3.Store(new N3.Parser({ baseIRI: doc }).parse(res.text));
  const get = (p: string) => st.getObjects(N3.DataFactory.namedNode(id), N3.DataFactory.namedNode(NS.schema + p), null)[0]?.value;
  const out = Object.fromEntries(FIELDS.map(([k, p]) => [k, get(p)]).filter(([, v]) => v !== undefined)) as unknown as PostalAddress;
  return out.streetAddress && out.country ? out : undefined;
}

export const toAcpAddress = (a: PostalAddress): AcpAddress => ({
  name: a.name, line_one: a.streetAddress, ...(a.extendedAddress ? { line_two: a.extendedAddress } : {}), city: a.locality,
  ...(a.region ? { state: a.region } : {}), country: a.country, postal_code: a.postalCode,
});
