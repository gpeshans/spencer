'use client';

import { Menu } from '@base-ui/react/menu';
import { Download, LogOut, Monitor, Moon, SlidersHorizontal, Sun, Users, Wallet } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { initialsFrom } from '@/lib/format';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { GroupMember } from '@/types/models';

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

const itemClass =
  'flex w-full cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

function displayName(m: GroupMember): string {
  return m.display_name?.trim() || m.email?.split('@')[0] || 'Member';
}

export function UserMenu({
  me,
  groupName,
  members,
}: {
  me: GroupMember;
  groupName: string;
  members: GroupMember[];
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const install = useInstallPrompt();
  // next-themes only knows the active theme on the client; gate the radio value
  // until mount so the server-rendered markup matches the first client render.
  const mounted = useMounted();

  async function signOut() {
    setSigningOut(true);
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Open profile menu"
        className="rounded-full outline-none transition-transform focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95"
      >
        <Avatar className="border">
          {me.avatar_url ? (
            <AvatarImage src={me.avatar_url} alt="" referrerPolicy="no-referrer" />
          ) : null}
          <AvatarFallback>{initialsFrom(me.display_name, me.email)}</AvatarFallback>
        </Avatar>
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50 outline-none">
          <Menu.Popup
            className={cn(
              'w-64 origin-top-right rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg shadow-black/5 outline-none',
              'transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            )}
          >
            {/* Identity */}
            <div className="flex items-center gap-3 px-2 py-1.5">
              <Avatar className="border">
                {me.avatar_url ? (
                  <AvatarImage src={me.avatar_url} alt="" referrerPolicy="no-referrer" />
                ) : null}
                <AvatarFallback>{initialsFrom(me.display_name, me.email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{displayName(me)}</p>
                {me.email ? (
                  <p className="truncate text-xs text-muted-foreground">{me.email}</p>
                ) : null}
              </div>
            </div>

            <Menu.Separator className="my-1.5 h-px bg-border" />

            {/* Theme */}
            <div className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Theme</div>
            <Menu.RadioGroup
              value={mounted ? theme : undefined}
              onValueChange={(value) => setTheme(value as string)}
              className="grid grid-cols-3 gap-1 px-1"
            >
              {THEMES.map(({ value, label, icon: Icon }) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  closeOnClick={false}
                  className={cn(
                    'flex cursor-default flex-col items-center gap-1 rounded-lg border border-transparent py-2 text-xs outline-none select-none',
                    'data-[highlighted]:bg-accent data-[checked]:border-border data-[checked]:bg-accent data-[checked]:font-medium',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>

            <Menu.Separator className="my-1.5 h-px bg-border" />

            {/* Family */}
            <div className="flex items-center gap-1.5 px-2.5 pb-1 text-xs font-medium text-muted-foreground">
              <Users className="size-3.5" />
              {groupName}
            </div>
            <div className="flex flex-col px-1">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
                  <Avatar className="size-7">
                    {m.avatar_url ? (
                      <AvatarImage src={m.avatar_url} alt="" referrerPolicy="no-referrer" />
                    ) : null}
                    <AvatarFallback className="text-xs">
                      {initialsFrom(m.display_name, m.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm">{displayName(m)}</span>
                  {m.id === me.id ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
                      you
                    </span>
                  ) : null}
                </div>
              ))}
            </div>

            <Menu.Separator className="my-1.5 h-px bg-border" />

            <Menu.Item className={itemClass} onClick={() => router.push('/income')}>
              <Wallet className="size-4 text-muted-foreground" />
              Monthly income
            </Menu.Item>

            <Menu.Item className={itemClass} onClick={() => router.push('/settings')}>
              <SlidersHorizontal className="size-4 text-muted-foreground" />
              Categories &amp; budget
            </Menu.Item>

            {(install.canPrompt || install.showIOSHint) && (
              <>
                <Menu.Separator className="my-1.5 h-px bg-border" />
                <Menu.Item className={itemClass} onClick={() => install.trigger()}>
                  <Download className="size-4 text-muted-foreground" />
                  Install app
                </Menu.Item>
              </>
            )}

            <Menu.Separator className="my-1.5 h-px bg-border" />

            <Menu.Item
              className={cn(
                itemClass,
                'text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive',
              )}
              closeOnClick={false}
              disabled={signingOut}
              onClick={signOut}
            >
              <LogOut className="size-4" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** Client-only flag (false on the server, true after hydration), no setState-in-effect. */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function matchesStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

/**
 * Wires up "Install app". On Chromium the browser fires `beforeinstallprompt`,
 * which we stash and replay on click (`canPrompt`). iOS Safari has no such event,
 * so there we surface manual "Add to Home Screen" steps (`showIOSHint`). Both are
 * suppressed once the app runs standalone. Display-mode and the UA are read via
 * useSyncExternalStore so nothing calls setState synchronously during an effect.
 */
function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [appInstalled, setAppInstalled] = useState(false);

  const standalone = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia('(display-mode: standalone)');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    matchesStandalone,
    () => false,
  );

  const isIOS = useSyncExternalStore(
    () => () => {},
    () =>
      /ipad|iphone|ipod/i.test(navigator.userAgent) &&
      !/crios|fxios|edgios/i.test(navigator.userAgent),
    () => false,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setAppInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const installed = standalone || appInstalled;
  return {
    canPrompt: !installed && deferred !== null,
    showIOSHint: !installed && isIOS && deferred === null,
    async trigger() {
      if (deferred) {
        await deferred.prompt();
        setDeferred(null);
      } else {
        toast('Install Spencer', {
          description: 'Tap the Share button, then “Add to Home Screen”.',
        });
      }
    },
  };
}
