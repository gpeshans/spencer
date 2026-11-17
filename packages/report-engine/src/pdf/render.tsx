import { Font, renderToBuffer } from '@react-pdf/renderer';

import type { ReportDocument } from '../report/document';
import { ReportPdf } from './document';

export interface PdfFonts {
  /** Path to a TTF or WOFF file for body text. */
  regular: string;
  /** Path to one for headings and figures. */
  bold: string;
}

export interface PdfOptions {
  /** BCP 47, e.g. de-DE: how numbers and dates read. */
  locale: string;
  /** When the data was read (ISO 8601), shown as "Data as of …". */
  asOf?: string;
  /** IANA time zone for "Data as of", e.g. Europe/Berlin. */
  timeZone?: string;
  /** A name for the header and footer, e.g. the app's. */
  brand?: string;
  /**
   * Font files, read from disk. Without them the PDF uses Helvetica, which
   * only covers Western European text.
   */
  fonts?: PdfFonts;
}

const families = new Map<string, string>();
let hyphenationOff = false;

/** Registers the fonts once per pair of files, and returns their family name. */
function familyFor(fonts: PdfFonts | undefined): string {
  if (!fonts) return 'Helvetica';
  const key = `${fonts.regular}\n${fonts.bold}`;
  let family = families.get(key);
  if (!family) {
    family = `ReportSans${families.size}`;
    Font.register({
      family,
      fonts: [
        { src: fonts.regular, fontWeight: 'normal' },
        { src: fonts.bold, fontWeight: 'bold' },
      ],
    });
    families.set(key, family);
  }
  return family;
}

function asOfText({ asOf, locale, timeZone }: PdfOptions): string | null {
  if (!asOf) return null;
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone && { timeZone }) }).format(date);
}

/**
 * The report as a PDF (docs/report-engine-spec.md §8). Nothing is fetched while
 * rendering: no images, no remote fonts, no links. Words aren't hyphenated;
 * react-pdf's setting for that is global, so this turns it off for the process.
 */
export async function renderReportPdf(report: ReportDocument, options: PdfOptions): Promise<Buffer> {
  if (!hyphenationOff) {
    Font.registerHyphenationCallback((word) => [word]);
    hyphenationOff = true;
  }
  const look = { locale: options.locale, family: familyFor(options.fonts), asOf: asOfText(options), brand: options.brand ?? null };
  return renderToBuffer(<ReportPdf report={report} look={look} />);
}
