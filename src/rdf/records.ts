/**
 * Deterministic mapping between domain records and Turtle documents.
 * The LLM never writes RDF: it proposes a structured interpretation, the user
 * confirms it, and this module generates the triples.
 */
import N3 from "n3";
import type {
  AgreedMeaning, Confirmation, Criterion, GroundRecord, Offer, PreferenceRecord, PurchaseIntention, SchemeId, SpendingMandate,
} from "../model.js";
import { SCHEME_IRI_NAME } from "../model.js";
import { NS, localName, sc, odrl, UNITS, unitName } from "./namespaces.js";

const { namedNode: nn, literal: lit, quad } = N3.DataFactory;
type Q = N3.Quad;
const RDF_TYPE = NS.rdf + "type";
const xsd = (t: string) => nn(NS.xsd + t);

function typed(v: string | number | boolean): N3.Literal {
  if (typeof v === "number") return Number.isInteger(v) ? lit(String(v), xsd("integer")) : lit(String(v), xsd("decimal"));
  if (typeof v === "boolean") return lit(String(v), xsd("boolean"));
  return lit(v);
}

class Doc {
  quads: Q[] = [];
  constructor(readonly url: string) {}
  node(fragment: string) { return nn(`${this.url}#${fragment}`); }
  add(s: string | N3.NamedNode, p: string, o: N3.Term | string | number | boolean) {
    const subj = typeof s === "string" ? nn(s) : s;
    const obj = typeof o === "object" ? o : typed(o);
    this.quads.push(quad(subj, nn(p), obj as N3.Quad_Object));
  }
  type(s: string | N3.NamedNode, t: string) { this.add(s, RDF_TYPE, nn(t)); }
  async toTurtle(): Promise<string> {
    const w = new N3.Writer({ prefixes: { ...NS, "": this.url + "#" } });
    w.addQuads(this.quads);
    return new Promise((res, rej) => w.end((e, out) => (e ? rej(e) : res(out ?? ""))));
  }
}

const docOf = (id: string) => id.split("#")[0];

function addCriterion(d: Doc, subject: N3.NamedNode, c: Criterion, frag = "criterion") {
  const cn = d.node(frag);
  d.add(subject, sc("criterion"), cn);
  d.type(cn, sc("Criterion"));
  d.add(cn, sc("leftOperand"), nn(sc(c.leftOperand)));
  d.add(cn, sc("operator"), nn(odrl(c.operator)));
  const values = Array.isArray(c.rightOperand) ? c.rightOperand : [c.rightOperand];
  for (const v of values) d.add(cn, sc("rightOperand"), typed(v));
  if (c.unit) d.add(cn, sc("unit"), nn(UNITS[c.unit] ?? c.unit));
  return cn;
}

function addCommon(d: Doc, s: N3.NamedNode, r: GroundRecord) {
  d.add(s, sc("owner"), nn(r.owner));
  d.add(s, sc("revision"), r.revision);
  d.add(s, sc("status"), nn(sc(r.status)));
  if (r.derivedFrom) {
    const st = d.node("statement");
    d.add(s, NS.prov + "wasDerivedFrom", st);
    d.add(st, sc("originalText"), lit(r.derivedFrom, "en"));
  }
  if (r.supersedes) d.add(s, NS.prov + "wasRevisionOf", nn(r.supersedes));
  if (r.proposedBy) d.add(s, NS.prov + "wasAttributedTo", lit(r.proposedBy));
  if (r.confirmation) addConfirmation(d, s, r.confirmation);
}

function addConfirmation(d: Doc, s: N3.NamedNode, c: Confirmation) {
  const cn = d.node("confirmation");
  d.add(s, sc("confirmation"), cn);
  d.type(cn, sc("Confirmation"));
  d.add(cn, sc("confirmedBy"), nn(c.by));
  d.add(cn, NS.prov + "endedAtTime", lit(c.at, xsd("dateTime")));
  d.add(cn, sc("keyId"), c.keyId);
  d.add(cn, sc("termsDigest"), c.termsDigest);
  d.add(cn, sc("signature"), c.signature);
}

export async function recordToTurtle(r: GroundRecord): Promise<string> {
  const d = new Doc(docOf(r.id));
  const s = nn(r.id);
  if (r.kind === "meaning") {
    d.type(s, sc("AgreedMeaning"));
    d.type(s, NS.skos + "Concept");
    d.add(s, sc("term"), lit(r.term, "en"));
    d.add(s, NS.skos + "prefLabel", lit(`${r.term} (${r.scope})`, "en"));
    d.add(s, NS.skos + "definition", lit(r.definition, "en"));
    d.add(s, sc("scope"), nn(sc(r.scope)));
    const cn = addCriterion(d, s, r.criterion);
    // sc:operationalizedAs is the semantic link; sc:criterion is the generic one
    d.add(s, sc("operationalizedAs"), cn);
  } else if (r.kind === "preference" || r.kind === "requirement") {
    d.type(s, sc(r.kind === "preference" ? "Preference" : "PurchaseRequirement"));
    d.add(s, sc("appliesTo"), nn(sc(r.appliesTo)));
    addCriterion(d, s, r.criterion);
    if (r.weight !== undefined) d.add(s, sc("weight"), lit(r.weight.toFixed(2), xsd("decimal")));
    if (r.groundedIn) d.add(s, sc("groundedIn"), nn(r.groundedIn));
  } else {
    writeMandate(d, s, r as SpendingMandate);
  }
  addCommon(d, s, r);
  return d.toTurtle();
}

function writeMandate(d: Doc, s: N3.NamedNode, m: SpendingMandate) {
  d.type(s, sc("SpendingMandate"));
  d.type(s, odrl("Set"));
  d.add(s, odrl("uid"), s);
  d.add(s, odrl("profile"), nn(NS.sc));
  d.add(s, odrl("assigner"), nn(m.owner));
  const p = d.node("permission");
  d.add(s, odrl("permission"), p);
  d.type(p, odrl("Permission"));
  d.add(p, odrl("action"), nn(sc("purchase")));
  for (const a of m.assignees) d.add(p, odrl("assignee"), nn(a));
  for (const t of m.targets) d.add(p, odrl("target"), nn(sc(t)));
  const cur = nn(sc(m.currency));
  const constraint = (frag: string, left: string, op: string, values: N3.Term[], unit?: N3.NamedNode) => {
    const c = d.node(frag);
    d.add(p, odrl("constraint"), c);
    d.type(c, odrl("Constraint"));
    d.add(c, odrl("leftOperand"), nn(left));
    d.add(c, odrl("operator"), nn(odrl(op)));
    for (const v of values) d.add(c, odrl("rightOperand"), v);
    if (unit) d.add(c, odrl("unit"), unit);
  };
  constraint("perTransaction", odrl("payAmount"), "lteq", [lit(m.maxPerTransaction, xsd("decimal"))], cur);
  constraint("total", sc("totalSpend"), "lteq", [lit(m.totalLimit, xsd("decimal"))], cur);
  constraint("expiry", odrl("dateTime"), "lt", [lit(m.validUntil, xsd("dateTime"))]);
  constraint("sellers", sc("seller"), "isAnyOf", m.allowedSellers.map((x) => nn(x)));
  constraint("schemes", sc("paymentScheme"), "isAnyOf", m.allowedSchemes.map((x) => nn(sc(SCHEME_IRI_NAME[x]))));
}

export async function intentionToTurtle(i: PurchaseIntention): Promise<string> {
  const d = new Doc(docOf(i.id));
  const s = nn(i.id);
  d.type(s, sc("PurchaseIntention"));
  d.add(s, sc("owner"), nn(i.owner));
  d.add(s, sc("wants"), nn(sc(i.category)));
  if (i.subject) d.add(s, sc("subject"), i.subject);
  d.add(s, sc("originalText"), lit(i.text, "en"));
  if (i.mandate) d.add(s, sc("governedBy"), nn(i.mandate));
  d.add(s, NS.dct + "created", lit(i.createdAt, xsd("dateTime")));
  return d.toTurtle();
}

// --------------------------------------------------------------- parsing

export function parseTurtle(text: string, baseIRI: string): N3.Store {
  return new N3.Store(new N3.Parser({ baseIRI }).parse(text));
}

const one = (st: N3.Store, s: N3.Term, p: string) => st.getObjects(s, nn(p), null)[0];
const all = (st: N3.Store, s: N3.Term, p: string) => st.getObjects(s, nn(p), null);
const val = (t?: N3.Term) => t?.value;

function literalValue(t: N3.Term): string | number {
  if (t.termType === "Literal") {
    const dt = (t as N3.Literal).datatype.value;
    if (dt === NS.xsd + "integer" || dt === NS.xsd + "decimal") return Number(t.value);
    return t.value;
  }
  return localName(t.value);
}

function readCriterion(st: N3.Store, cn: N3.Term): Criterion {
  const values = all(st, cn, sc("rightOperand")).map(literalValue);
  const operator = localName(val(one(st, cn, sc("operator")))!, "odrl") as Criterion["operator"];
  const unitIri = val(one(st, cn, sc("unit")));
  return {
    leftOperand: localName(val(one(st, cn, sc("leftOperand")))!),
    operator,
    rightOperand: operator === "isAnyOf" ? values.map(String) : values[0],
    ...(unitIri ? { unit: unitName(unitIri) } : {}),
  };
}

function readConfirmation(st: N3.Store, s: N3.Term): Confirmation | undefined {
  const cn = one(st, s, sc("confirmation"));
  if (!cn) return undefined;
  return {
    by: val(one(st, cn, sc("confirmedBy")))!,
    at: val(one(st, cn, NS.prov + "endedAtTime"))!,
    keyId: val(one(st, cn, sc("keyId")))!,
    termsDigest: val(one(st, cn, sc("termsDigest")))!,
    signature: val(one(st, cn, sc("signature")))!,
  };
}

/** Parse any ground record (meaning, preference, requirement, mandate) found at `id`. */
export function parseRecord(turtle: string, id: string): GroundRecord {
  const st = parseTurtle(turtle, docOf(id));
  const s = nn(id);
  const types = all(st, s, RDF_TYPE).map((t) => t.value);
  const stmt = one(st, s, NS.prov + "wasDerivedFrom");
  const base = {
    id,
    owner: val(one(st, s, sc("owner")))!,
    revision: Number(val(one(st, s, sc("revision")))),
    status: localName(val(one(st, s, sc("status")))!) as GroundRecord["status"],
    ...(stmt ? { derivedFrom: val(one(st, stmt, sc("originalText"))) } : {}),
    ...(one(st, s, NS.prov + "wasRevisionOf") ? { supersedes: val(one(st, s, NS.prov + "wasRevisionOf")) } : {}),
    ...(one(st, s, NS.prov + "wasAttributedTo") ? { proposedBy: val(one(st, s, NS.prov + "wasAttributedTo")) } : {}),
  };
  const confirmation = readConfirmation(st, s);
  const withConf = <T extends object>(r: T) => (confirmation ? { ...r, confirmation } : r);

  if (types.includes(sc("AgreedMeaning"))) {
    return withConf({
      ...base, kind: "meaning" as const,
      term: val(one(st, s, sc("term")))!,
      scope: localName(val(one(st, s, sc("scope")))!),
      definition: val(one(st, s, NS.skos + "definition"))!,
      criterion: readCriterion(st, one(st, s, sc("criterion"))!),
    }) as AgreedMeaning;
  }
  if (types.includes(sc("Preference")) || types.includes(sc("PurchaseRequirement"))) {
    const w = one(st, s, sc("weight"));
    const g = one(st, s, sc("groundedIn"));
    return withConf({
      ...base, kind: types.includes(sc("Preference")) ? ("preference" as const) : ("requirement" as const),
      appliesTo: localName(val(one(st, s, sc("appliesTo")))!),
      criterion: readCriterion(st, one(st, s, sc("criterion"))!),
      ...(w ? { weight: Number(w.value) } : {}),
      ...(g ? { groundedIn: g.value } : {}),
    }) as PreferenceRecord;
  }
  if (types.includes(sc("SpendingMandate"))) {
    const p = one(st, s, odrl("permission"))!;
    const byLeft = (left: string) => all(st, p, odrl("constraint")).find((c) => val(one(st, c, odrl("leftOperand"))) === left)!;
    const rights = (left: string) => all(st, byLeft(left), odrl("rightOperand")).map((t) => t.value);
    const schemeOf = (name: string) =>
      (Object.entries(SCHEME_IRI_NAME).find(([, v]) => v === name)?.[0] ?? name) as SchemeId;
    return withConf({
      ...base, kind: "mandate" as const,
      assignees: all(st, p, odrl("assignee")).map((t) => t.value).sort(),
      targets: all(st, p, odrl("target")).map((t) => localName(t.value)).sort(),
      currency: localName(val(one(st, byLeft(odrl("payAmount")), odrl("unit")))!),
      maxPerTransaction: rights(odrl("payAmount"))[0],
      totalLimit: rights(sc("totalSpend"))[0],
      validUntil: rights(odrl("dateTime"))[0],
      allowedSellers: rights(sc("seller")).sort(),
      allowedSchemes: rights(sc("paymentScheme")).map((x) => schemeOf(localName(x))).sort(),
    }) as SpendingMandate;
  }
  throw new Error(`No supported record type at ${id}`);
}

/** Normalise list fields so that signing before writing and after parsing gives the same digest. */
export function normalizeRecord<T extends GroundRecord>(r: T): T {
  if (r.kind !== "mandate") return r;
  return { ...r, assignees: [...r.assignees].sort(), targets: [...r.targets].sort(), allowedSellers: [...r.allowedSellers].sort(), allowedSchemes: [...r.allowedSchemes].sort() };
}

// --------------------------------------------------------------- seller offers (schema.org)

export async function offerToTurtle(o: Offer, signatureJson?: string): Promise<string> {
  const d = new Doc(docOf(o.offerId));
  const s = nn(o.offerId);
  d.type(s, NS.schema + "Offer");
  d.add(s, NS.schema + "seller", nn(o.seller));
  d.add(s, NS.schema + "url", nn(o.resource));
  d.add(s, NS.schema + "validThrough", lit(o.validUntil, xsd("dateTime")));
  d.add(s, NS.schema + "category", nn(sc(o.category)));
  d.add(s, sc("offerVersion"), o.version);
  d.add(s, sc("coverage"), o.coverage);
  const item = d.node("item");
  d.add(s, NS.schema + "itemOffered", item);
  d.type(item, sc(o.category));
  for (const [k, v] of Object.entries(o.properties).sort()) {
    const pv = d.node(`prop-${k}`);
    d.add(item, NS.schema + "additionalProperty", pv);
    d.type(pv, NS.schema + "PropertyValue");
    d.add(pv, NS.schema + "propertyID", nn(sc(k)));
    d.add(pv, NS.schema + "value", typed(v));
  }
  o.prices.forEach((pr, i) => {
    const ps = d.node(`price-${i}`);
    d.add(s, NS.schema + "priceSpecification", ps);
    d.type(ps, NS.schema + "UnitPriceSpecification");
    d.add(ps, NS.schema + "price", lit(pr.amount, xsd("integer")));
    d.add(ps, NS.schema + "priceCurrency", pr.currency);
    d.add(ps, sc("paymentScheme"), nn(sc(SCHEME_IRI_NAME[pr.scheme])));
    d.add(ps, NS.rdfs + "comment", lit("price is in atomic units of priceCurrency"));
  });
  if (signatureJson) d.add(s, sc("signature"), signatureJson);
  return d.toTurtle();
}
