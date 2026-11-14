export const NS = {
  sc: "https://w3id.org/solid-commerce#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  prov: "http://www.w3.org/ns/prov#",
  odrl: "http://www.w3.org/ns/odrl/2/",
  schema: "https://schema.org/",
  dct: "http://purl.org/dc/terms/",
  unit: "http://qudt.org/vocab/unit/",
  acl: "http://www.w3.org/ns/auth/acl#",
  foaf: "http://xmlns.com/foaf/0.1/",
  solid: "http://www.w3.org/ns/solid/terms#",
  ldp: "http://www.w3.org/ns/ldp#",
} as const;

export type Prefix = keyof typeof NS;
export const iri = (prefix: Prefix, local: string) => NS[prefix] + local;
export const sc = (l: string) => NS.sc + l;
export const odrl = (l: string) => NS.odrl + l;

/** Strip a known namespace, returning the local name (or the input if none matches). */
export function localName(value: string, prefix: Prefix = "sc"): string {
  return value.startsWith(NS[prefix]) ? value.slice(NS[prefix].length) : value;
}

/** Map of human unit names to QUDT unit IRIs. */
export const UNITS: Record<string, string> = { minute: NS.unit + "MIN", hour: NS.unit + "HR" };
export const unitName = (iriValue: string) => Object.entries(UNITS).find(([, v]) => v === iriValue)?.[0] ?? iriValue;
