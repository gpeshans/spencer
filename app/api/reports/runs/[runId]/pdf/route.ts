import { existsSync } from 'node:fs';
import path from 'node:path';

import { renderReportPdf } from 'report-engine/pdf';
import { buildReport, reportFileName } from 'report-engine/report';

import { APP_TIMEZONE, DEFAULT_CURRENCY, LOCALE, todayISO } from '@/lib/format';
import { failure, isRunId, problem, signedIn } from '@/lib/reports/http';
import { reportPresentation } from '@/lib/reports/presentation';
import { loadRun } from '@/lib/reports/store';

/** Geist, the app's typeface. next.config.ts ships these two files with the route. */
const GEIST = {
  regular: path.join(process.cwd(), 'node_modules', 'geist', 'dist', 'fonts', 'geist-sans', 'Geist-Regular.ttf'),
  bold: path.join(process.cwd(), 'node_modules', 'geist', 'dist', 'fonts', 'geist-sans', 'Geist-SemiBold.ttf'),
};

let fonts: typeof GEIST | undefined | null = null;

/** Geist when its files are there; otherwise the PDF falls back to Helvetica rather than failing. */
function pdfFonts(): typeof GEIST | undefined {
  if (fonts === null) {
    fonts = existsSync(GEIST.regular) && existsSync(GEIST.bold) ? GEIST : undefined;
    if (!fonts) console.warn('reports pdf: the Geist font files are missing; using Helvetica.', GEIST);
  }
  return fonts;
}

/**
 * A finished report as a PDF, drawn from the same document as its page
 * (docs/report-engine-spec.md §5.6, §8). Made on request, for its author only.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const me = await signedIn();
  if (me instanceof Response) return me;
  const { runId } = await params;
  if (!isRunId(runId)) return problem(404, 'not_found', 'There is no such report run.');
  try {
    // Read as the signed-in person: RLS hides everyone else's runs.
    const stored = await loadRun(me.supabase, runId);
    if (!stored) return problem(404, 'not_found', 'There is no such report run.');
    const { vocabulary, styles } = await reportPresentation();
    const report = buildReport(stored.state, vocabulary, { currency: DEFAULT_CURRENCY, styles });
    if (!report) return problem(409, 'not_finished', 'This report has no results to download yet.');
    const pdf = await renderReportPdf(report, {
      locale: LOCALE,
      timeZone: APP_TIMEZONE,
      // A finished run is last written when it ends.
      asOf: stored.updatedAt,
      brand: 'Spencer',
      fonts: pdfFonts(),
    });
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${reportFileName(report.title, todayISO())}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return failure(error, `GET /api/reports/runs/${runId}/pdf`);
  }
}
