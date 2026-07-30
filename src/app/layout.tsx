import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

import './globals.css'

// DESIGN.md names Inter. `shadcn init` swapped in Geist as part of its preset —
// that is exactly the shadcn default look the same document says not to accept.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

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
    <html lang="en" className={`h-full ${inter.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
