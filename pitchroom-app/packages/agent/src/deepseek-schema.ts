type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);

// oneOf and anyOf are equivalent only when alternatives cannot overlap. Prove
// that here using a required string discriminator with distinct const values.
// Refuse other oneOf forms instead of silently weakening their meaning.
function disjointAlternatives(value: unknown): value is Schema[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(object)) return false;
  const first = value[0]!;
  if (!object(first.properties)) return false;
  return Object.keys(first.properties).some(key => {
    const tags: string[] = [];
    for (const branch of value) {
      if (branch.type !== "object" || !Array.isArray(branch.required) || !branch.required.includes(key) || !object(branch.properties)) return false;
      const discriminator = branch.properties[key];
      if (!object(discriminator) || discriminator.type !== "string" || typeof discriminator.const !== "string") return false;
      tags.push(discriminator.const);
    }
    return new Set(tags).size === tags.length;
  });
}

export function deepSeekOutputSchema(schema: unknown): unknown {
  function visit(value: unknown): unknown {
    if (typeof value === "boolean") return value;
    if (!object(value)) throw new Error("UNSUPPORTED_OUTPUT_SCHEMA");
    const result: Schema = { ...value };
    if (Object.hasOwn(value, "oneOf")) {
      if (Object.hasOwn(value, "anyOf") || !disjointAlternatives(value.oneOf)) throw new Error("UNSUPPORTED_OUTPUT_SCHEMA");
      delete result.oneOf;
      result.anyOf = value.oneOf.map(visit);
    }
    // Traverse schema positions only. Do not rewrite property names, const/enum
    // data, descriptions, examples or other annotations containing "oneOf".
    for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
      if (object(value[key])) result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, child]) => [name, visit(child)]));
    }
    for (const key of ["anyOf", "allOf", "prefixItems"]) {
      if (Array.isArray(value[key])) result[key] = value[key].map(visit);
    }
    for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
      if (value[key] !== undefined) result[key] = Array.isArray(value[key]) ? value[key].map(visit) : visit(value[key]);
    }
    return result;
  }
  return visit(schema);
}
