import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import rdf from "@zazuko/env";
import SHACLValidator from "rdf-validate-shacl";
import N3 from "n3";

const SHAPES_PATH = fileURLToPath(new URL("../../ontology/shapes.ttl", import.meta.url));
let validator: SHACLValidator | undefined;

function getValidator(): SHACLValidator {
  if (!validator) {
    const shapes = rdf.dataset(new N3.Parser().parse(readFileSync(SHAPES_PATH, "utf8")) as any);
    validator = new SHACLValidator(shapes, { factory: rdf as any });
  }
  return validator;
}

export interface ShaclResult { conforms: boolean; messages: string[] }

/** Validate a Turtle document against ontology/shapes.ttl. */
export async function validateTurtle(turtle: string, baseIRI: string): Promise<ShaclResult> {
  const data = rdf.dataset(new N3.Parser({ baseIRI }).parse(turtle) as any);
  const report = await getValidator().validate(data);
  return {
    conforms: report.conforms,
    messages: report.results.map((r: any) =>
      `${r.focusNode?.value ?? "?"} ${r.path?.value ?? ""}: ${r.message.map((m: any) => m.value).join("; ")}`),
  };
}
