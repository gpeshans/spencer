'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function signOut() {
    setLoading(true);
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={signOut}
      disabled={loading}
      className="gap-2 text-muted-foreground"
    >
      <LogOut className="size-4" />
      Sign out
    </Button>
  );
}
