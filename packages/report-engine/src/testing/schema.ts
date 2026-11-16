type Node = Record<string, unknown>;

/**
 * Union-typed fields (anyOf, or a type array such as ["string", "null"]) in a
 * JSON schema as sent to the API, which allows at most 16 per request. Counts
 * every field and array item whose schema is a union, following $refs.
 */
export function countUnions(schema: Node): number {
  const defs = (schema.$defs ?? {}) as Record<string, Node>;
  const resolve = (node: Node): Node => (typeof node.$ref === 'string' ? (defs[node.$ref.split('/').pop()!] ?? {}) : node);
  const isUnion = (node: Node) => Array.isArray(node.anyOf) || Array.isArray(node.type);
  let unions = 0;
  const walk = (raw: Node, depth: number) => {
    if (depth > 50) return;
    const node = resolve(raw);
    for (const branch of (node.anyOf as Node[] | undefined) ?? []) walk(branch, depth + 1);
    if (node.items) {
      if (isUnion(resolve(node.items as Node))) unions += 1;
      walk(node.items as Node, depth + 1);
    }
    for (const child of Object.values((node.properties as Record<string, Node> | undefined) ?? {})) {
      if (isUnion(resolve(child))) unions += 1;
      walk(child, depth + 1);
    }
  };
  walk(schema, 0);
  return unions;
}
