import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lead Funnel Dashboard',
  description: 'Track ad → landing → call → sale conversion across companies.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* suppressHydrationWarning shields against browser extensions
          (Grammarly, password managers, dark-mode plugins) that inject
          attributes on <body> after first paint and would otherwise
          trip React's hydration check. */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
