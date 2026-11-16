'use client';

import type { RunStatus } from 'report-engine';

import { Badge } from '@/components/ui/badge';

const LABEL: Record<RunStatus, string> = {
  received: 'Starting',
  planning: 'Planning',
  needs_clarification: 'Question',
  awaiting_approval: 'Needs approval',
  executing: 'Running',
  succeeded: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  rejected: 'Declined',
  expired: 'Expired',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const variant =
    status === 'failed' ? 'destructive' : status === 'succeeded' ? 'default' : status === 'partial' ? 'outline' : 'secondary';
  return <Badge variant={variant}>{LABEL[status]}</Badge>;
}
