import 'server-only';

import type { SemanticModel } from 'report-engine';
// The light entry: no SQL parser, database driver or LLM client in the pages' bundles.
import { buildVocabulary, isColor, type ReportStyles, type ReportVocabulary, type ValueStyle } from 'report-engine/report';

import { BUCKETS, type CategoryDTO } from '@/lib/categories';
import { getCategories } from '@/lib/categories-data';
import { MEMBER_COLORS } from '@/lib/members';
import { getGroupContext } from '@/lib/session';
import modelFile from '@/supabase/reporting/semantic-model.json';

/**
 * What the report pages and the PDF need to show a finished run: the semantic
 * model's names and units, and Spencer's own labels and colours for values,
 * so a report's Groceries is the same green as everywhere else in the app.
 */
export interface ReportPresentation {
  vocabulary: ReportVocabulary;
  styles: ReportStyles;
}

let vocabulary: ReportVocabulary | undefined;

/**
 * The vocabulary as plain data, which can go to the browser. The model file is
 * checked against its schema by `npm run reports:model -- --check` and parsed
 * by the engine before every run, so a cast is enough here.
 */
export function reportVocabulary(): ReportVocabulary {
  if (!vocabulary) {
    const { relations, metrics, dimensions } = buildVocabulary(modelFile as unknown as SemanticModel);
    vocabulary = { relations, metrics, dimensions };
  }
  return vocabulary;
}

const byLabel = (categories: readonly CategoryDTO[]): Record<string, ValueStyle> =>
  Object.fromEntries(categories.filter((category) => isColor(category.color)).map((category) => [category.label, { color: category.color }]));

/**
 * Labels and colours by the semantic model's dimension names. The reporting
 * views name categories by label and members by display name; buckets keep
 * their keys, shown by their labels.
 */
export async function reportStyles(): Promise<ReportStyles> {
  const [{ expense, income }, context] = await Promise.all([getCategories(), getGroupContext()]);
  return {
    category: byLabel(expense),
    income_category: byLabel(income),
    bucket: Object.fromEntries(BUCKETS.map((bucket) => [bucket.key, { label: bucket.label, color: bucket.color }])),
    // The same slots as the app's member charts: by position in the group (join order).
    member: Object.fromEntries(
      (context?.members ?? []).flatMap((member, index) =>
        member.display_name ? [[member.display_name, { color: MEMBER_COLORS[index % MEMBER_COLORS.length]! }]] : [],
      ),
    ),
  };
}

export async function reportPresentation(): Promise<ReportPresentation> {
  return { vocabulary: reportVocabulary(), styles: await reportStyles() };
}
