import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Loupe',
  description: 'Qimati listing console',
  // Internal tool pointed at a live store. It should never be indexed.
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  )
}
