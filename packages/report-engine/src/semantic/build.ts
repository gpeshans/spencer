import { createHash } from 'node:crypto';

import { columnKind } from '../plan/vocabulary';
import { createSqlGuard } from '../sql-guard';
import type { Introspection } from './introspect';
import type { SemanticModel } from './model';

/** sha256 over the introspected relations (names, kinds, columns, types, comments). */
export function schemaHash(introspection: Pick<Introspection, 'schemas' | 'relations'>): string {
  const canonical = JSON.stringify({ schemas: introspection.schemas, relations: introspection.relations });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface Freshness {
  fresh: boolean;
  /** The hash the model was built from. */
  model: string;
  /** The hash of the database as it is now. */
  database: string;
}

/** A model is fresh when it was built from the database as it is now. */
export function checkFreshness(model: SemanticModel, introspection: Introspection): Freshness {
  const database = schemaHash(introspection);
  return { fresh: model.schemaHash === database, model: model.schemaHash, database };
}

export interface BuildInput {
  introspection: Introspection;
  /** The current model file, if any: its curated sections are carried over. */
  previous?: SemanticModel;
  now?: Date;
}

export interface BuildResult {
  model: SemanticModel;
  /** Curated entries that no longer fit the relations (or fail the SQL guard). */
  problems: string[];
  /** From introspection: ways a query could read past row-level security. */
  warnings: string[];
}

/** Regenerates the relations, keeps the curated sections, and checks both. */
export async function buildSemanticModel({ introspection, previous, now = new Date() }: BuildInput): Promise<BuildResult> {
  const hash = schemaHash(introspection);
  const model: SemanticModel = {
    version: 1,
    // Unchanged relations keep their date, so a rebuild without changes is no diff.
    generatedAt: previous && previous.schemaHash === hash ? previous.generatedAt : now.toISOString(),
    schemaHash: hash,
    schemas: introspection.schemas,
    relations: introspection.relations,
    metrics: previous?.metrics ?? [],
    dimensions: previous?.dimensions ?? [],
    columnUnits: previous?.columnUnits ?? [],
    synonyms: previous?.synonyms ?? [],
    examples: previous?.examples ?? [],
    suggestedReports: previous?.suggestedReports ?? [],
  };
  return { model, problems: await checkCurated(model), warnings: introspection.warnings };
}

/** Checks every curated entry against the model's relations and the SQL guard. */
export async function checkCurated(model: SemanticModel): Promise<string[]> {
  const relations = new Map(model.relations.map((relation) => [relation.name, relation]));
  const guard = createSqlGuard({ relations: [...relations.keys()] });
  const problems: string[] = [];

  const duplicates = (names: string[]) => names.filter((name, index) => names.indexOf(name) !== index);
  for (const name of new Set(duplicates(model.metrics.map((m) => m.name)))) problems.push(`metric ${name} is defined twice.`);
  for (const name of new Set(duplicates(model.dimensions.map((d) => d.name)))) {
    problems.push(`dimension ${name} is defined twice.`);
  }

  for (const metric of model.metrics) {
    if (!relations.has(metric.relation)) {
      problems.push(`metric ${metric.name}: ${metric.relation} is not a readable relation.`);
      continue;
    }
    const check = await guard.check(`select ${metric.expression} from ${metric.relation}`);
    if (!check.ok) {
      problems.push(`metric ${metric.name}: ${check.issues.map((issue) => issue.message).join(' ')}`);
    }
  }

  for (const dimension of model.dimensions) {
    const relation = relations.get(dimension.relation);
    if (!relation) {
      problems.push(`dimension ${dimension.name}: ${dimension.relation} is not a readable relation.`);
    } else if (!relation.columns.some((column) => column.name === dimension.column)) {
      problems.push(`dimension ${dimension.name}: ${dimension.relation} has no column ${dimension.column}.`);
    }
  }

  const unitKeys = model.columnUnits.map((entry) => `${entry.relation}.${entry.column}`);
  for (const key of new Set(duplicates(unitKeys))) problems.push(`column unit ${key} is defined twice.`);
  for (const entry of model.columnUnits) {
    const name = `column unit ${entry.relation}.${entry.column}`;
    const relation = relations.get(entry.relation);
    const column = relation?.columns.find((candidate) => candidate.name === entry.column);
    if (!relation) problems.push(`${name}: ${entry.relation} is not a readable relation.`);
    else if (!column) problems.push(`${name}: ${entry.relation} has no column ${entry.column}.`);
    else if (columnKind(column.type) !== 'number') problems.push(`${name}: ${column.type} is not a number type.`);
  }

  for (const [index, example] of model.examples.entries()) {
    const check = await guard.check(example.sql, { paramCount: example.params.length });
    if (!check.ok) {
      problems.push(`example ${index + 1} ("${example.question}"): ${check.issues.map((i) => i.message).join(' ')}`);
    }
  }

  return problems;
}
