import { NextRequest, NextResponse } from 'next/server';

import { isSupportedCurrency } from '@/lib/currencies';
import { fetchFxRate } from '@/lib/fx';

/** Live home->display rate for the report view-currency toggle. Not
 * authenticated beyond "same origin" — it returns no user data, just a public
 * exchange rate, so there's nothing to protect here. */
export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get('from');
  const to = request.nextUrl.searchParams.get('to');
  if (!from || !to || !isSupportedCurrency(from) || !isSupportedCurrency(to)) {
    return NextResponse.json({ error: 'Invalid currency' }, { status: 400 });
  }

  try {
    const rate = await fetchFxRate(from, to, 'latest');
    return NextResponse.json({ rate });
  } catch {
    return NextResponse.json({ error: 'Could not fetch exchange rate' }, { status: 502 });
  }
}
