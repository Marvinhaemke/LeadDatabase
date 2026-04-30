'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/admin', label: 'Companies' },
  { href: '/admin/users', label: 'Users' },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-border">
      {TABS.map((t) => {
        const active =
          pathname === t.href ||
          (t.href !== '/admin' && pathname?.startsWith(`${t.href}/`));
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'px-3 py-2 text-sm',
              active
                ? 'border-b-2 border-foreground font-medium'
                : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
