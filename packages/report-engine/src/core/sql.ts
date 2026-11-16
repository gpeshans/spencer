/**
 * Quoting for the SQL that code builds from semantic-model names. Relation
 * names are validated as `schema.name` by the model, but column names come
 * from introspection as they are, so every identifier is quoted.
 */

export function quoteIdentifier(name: string): string {
  if (name.length === 0 || name.includes('\0')) throw new Error('quoteIdentifier: invalid identifier');
  return `"${name.replaceAll('"', '""')}"`;
}

/** `schema.name` → `"schema"."name"`. */
export function quoteQualified(name: string): string {
  const parts = name.split('.');
  if (parts.length !== 2) throw new Error(`quoteQualified: "${name}" must be schema.name`);
  return parts.map(quoteIdentifier).join('.');
}
