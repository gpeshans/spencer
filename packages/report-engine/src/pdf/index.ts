/**
 * The report as a PDF, with @react-pdf/renderer. Server-only, and kept apart
 * from the rest of the engine (`report-engine/pdf`), so only the code that
 * makes PDFs loads it.
 */
export { extent, labelEvery, niceTicks, pieSlices } from './geometry';
export { renderReportPdf, type PdfFonts, type PdfOptions } from './render';
