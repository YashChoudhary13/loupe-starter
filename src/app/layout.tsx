import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'

import { FACES, faceFromHeader } from '@/lib/faces/faces'

import './globals.css'

// DESIGN.md names Inter. `shadcn init` swapped in Geist as part of its preset —
// that is exactly the shadcn default look the same document says not to accept.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

/** The face is decided by the proxy from the hostname (D136); the tab title and the palette follow it. */
export async function generateMetadata(): Promise<Metadata> {
  const face = faceFromHeader((await headers()).get('x-face'))
  return {
    title: face ? FACES[face].label : 'Loupe',
    description: 'Qimati operations',
    // Internal tool pointed at a live store. It should never be indexed.
    robots: { index: false, follow: false },
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const face = faceFromHeader((await headers()).get('x-face'))
  return (
    <html lang="en" data-face={face ?? undefined} className={`h-full ${inter.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
