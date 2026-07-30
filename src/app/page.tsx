import { redirect } from 'next/navigation'

/**
 * There is one screen worth landing on. `/console` redirects to `/login` when
 * nobody is signed in, so this needs no auth check of its own — and adding one
 * would be a second place that has to stay correct.
 */
export default function Home() {
  redirect('/console')
}
