import 'server-only';

// The email whitelist lives in a SERVER-ONLY env var so it is never shipped to
// the browser. `import 'server-only'` makes a client import a build error.

export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email?: string | null): boolean {
  if (!email) return false;
  return getAllowedEmails().includes(email.toLowerCase());
}
