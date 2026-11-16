import type postgres from 'postgres';

import type { RelationKind, SemanticColumn } from './model';

/**
 * Reads what the reporting role can see in the given schemas, and flags
 * anything that would let a query read past row-level security
 * (docs/report-engine-spec.md §4, stage 0).
 */

export interface IntrospectOptions {
  /** Schemas to read, e.g. ['reporting']. */
  schemas: readonly string[];
  /** Role to look through (SET LOCAL ROLE), so privileges match report runs. */
  role?: string;
  /** SECURITY DEFINER functions that are expected, e.g. the scope check. */
  trustedFunctions?: readonly string[];
}

export interface IntrospectedRelation {
  name: string;
  kind: RelationKind;
  description?: string;
  columns: SemanticColumn[];
}

export interface Introspection {
  schemas: string[];
  relations: IntrospectedRelation[];
  /** Ways a query could read past row-level security. Empty is the goal. */
  warnings: string[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const KINDS: Readonly<Record<string, RelationKind>> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'materialized_view',
  f: 'foreign_table',
};

export async function introspect(sql: postgres.Sql, options: IntrospectOptions): Promise<Introspection> {
  const schemas = [...options.schemas].sort();
  if (!schemas.every((schema) => IDENTIFIER.test(schema))) {
    throw new Error('introspect: schemas must be lowercase identifiers');
  }
  if (options.role !== undefined && !IDENTIFIER.test(options.role)) {
    throw new Error('introspect: role must be a lowercase identifier');
  }
  const trusted = new Set(options.trustedFunctions ?? []);

  return sql.begin('read only', async (tx) => {
    if (options.role) await tx.unsafe(`set local role ${options.role}`, [], { simple: false, prepare: false });
    await tx`select set_config('search_path', 'pg_catalog', true)`;

    const relationRows = await tx`
      select n.nspname || '.' || c.relname as name,
             c.relkind as kind,
             coalesce(c.reloptions, '{}') as options,
             c.relrowsecurity as rls,
             obj_description(c.oid, 'pg_class') as description
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas})
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_any_column_privilege(c.oid, 'SELECT')
      order by 1`;

    const columnRows = await tx`
      select n.nspname || '.' || c.relname as relation,
             a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             col_description(c.oid, a.attnum) as description
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas})
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and a.attnum > 0
        and not a.attisdropped
        and has_column_privilege(c.oid, a.attnum, 'SELECT')
      order by 1, a.attnum`;

    // Relations outside these schemas that the views here read. Those inside
    // are checked as relations in their own right.
    const externalBases = await tx`
      select distinct n.nspname || '.' || v.relname as view,
             tn.nspname || '.' || t.relname as base,
             t.relkind as kind,
             coalesce(t.reloptions, '{}') as options,
             t.relrowsecurity as rls
      from pg_rewrite r
      join pg_class v on v.oid = r.ev_class
      join pg_namespace n on n.oid = v.relnamespace
      join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
      join pg_class t on t.oid = d.refobjid and t.oid <> v.oid
      join pg_namespace tn on tn.oid = t.relnamespace
      where n.nspname = any(${schemas})
        and not tn.nspname = any(${schemas})
        and t.relkind in ('r', 'p', 'v', 'm', 'f')
      order by 1, 2`;

    const definers = await tx`
      select n.nspname || '.' || p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${schemas}) and p.prosecdef
      order by 1`;

    await tx.rollback();

    const columnsByRelation = new Map<string, SemanticColumn[]>();
    for (const row of columnRows) {
      const list = columnsByRelation.get(row.relation) ?? [];
      list.push({ name: row.name, type: row.type, ...(row.description && { description: row.description }) });
      columnsByRelation.set(row.relation, list);
    }

    const warnings: string[] = [];
    const relations: IntrospectedRelation[] = relationRows.map((row) => {
      const kind = KINDS[row.kind] ?? 'table';
      const securityInvoker = isSecurityInvoker(row.options as string[]);
      if (kind === 'view' && !securityInvoker) {
        warnings.push(`${row.name} is a view without security_invoker: it reads with its owner's rights, past RLS.`);
      }
      if (kind === 'materialized_view') warnings.push(`${row.name} is a materialized view: it has no row-level security.`);
      if (kind === 'foreign_table') warnings.push(`${row.name} is a foreign table: row-level security doesn't reach it.`);
      if (kind === 'table' && !row.rls) warnings.push(`${row.name} has row-level security off.`);
      return {
        name: row.name,
        kind,
        ...(row.description && { description: row.description }),
        columns: columnsByRelation.get(row.name) ?? [],
      };
    });
    for (const row of externalBases) {
      const kind = KINDS[row.kind] ?? 'table';
      if (kind === 'table' && !row.rls) {
        warnings.push(`${row.view} reads ${row.base}, which has row-level security off.`);
      } else if (kind === 'view' && !isSecurityInvoker(row.options as string[])) {
        warnings.push(`${row.view} reads ${row.base}, a view that runs with its owner's rights, past RLS.`);
      } else if (kind === 'materialized_view') {
        warnings.push(`${row.view} reads ${row.base}, a materialized view, which has no row-level security.`);
      } else if (kind === 'foreign_table') {
        warnings.push(`${row.view} reads ${row.base}, a foreign table, which row-level security doesn't reach.`);
      }
    }
    for (const row of definers) {
      if (!trusted.has(row.name)) {
        warnings.push(`${row.name} is SECURITY DEFINER: it runs with its owner's rights.`);
      }
    }

    return { schemas, relations, warnings };
  });
}

function isSecurityInvoker(options: string[]): boolean {
  return options.some((option) => /^security_invoker=(true|on|1|yes)$/i.test(option));
}
