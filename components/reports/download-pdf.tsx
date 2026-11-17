'use client';

import { Download, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { fetchPdf, ReportApiError } from '@/lib/reports/client';

/**
 * Downloads the report as a PDF. It fetches the file first, rather than
 * linking to it, so the button can show it's working and a failure is a
 * message here rather than an error page.
 */
export function DownloadPdf({ runId, fileName }: { runId: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const url = URL.createObjectURL(await fetchPdf(runId));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      // Some browsers start the download only after this turn; give them a moment.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast.error(error instanceof ReportApiError ? error.message : 'The PDF couldn’t be made. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={() => void download()}>
      {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
      {busy ? 'Preparing…' : 'Download PDF'}
    </Button>
  );
}
