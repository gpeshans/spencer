import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Space_Grotesk } from 'next/font/google';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// Variable names must match the tokens referenced in globals.css @theme.
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
// Modern geometric display face used only for the "Spencer" wordmark.
const brandFont = Space_Grotesk({ variable: '--font-brand', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Spencer',
  description: 'Simple mobile-first family spending tracker.',
  applicationName: 'Spencer',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Spencer' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${brandFont.variable} h-full antialiased`}
    >
      <body className="min-h-dvh bg-background text-foreground">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-center" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
