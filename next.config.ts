import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * How long the CLIENT-side router may reuse an already-fetched section
     * before going back to the server.
     *
     * Every screen here is `force-dynamic`, and with no stale time the router
     * re-fetched the whole payload on every navigation — so bouncing between
     * Console and Tracking paid a full server round trip each way, even when
     * nothing had changed in the intervening seconds.
     *
     * 30 seconds is chosen against how this tool is actually used: an operator
     * flicking between sections wants the previous view back instantly, while
     * genuinely new work arrives from Drive on a cron measured in minutes. The
     * console additionally polls its own counters every 5s and refreshes itself
     * when work completes, so a cached shell never hides finished work.
     *
     * This is a NAVIGATION cache, not a security boundary. Authorisation is
     * re-checked server-side on every render and inside every server action
     * (D44), so a cached payload cannot let a deactivated operator do anything.
     */
    staleTimes: {
      dynamic: 30,
      // Also 30 since D174. `static` is what the router applies to a screen read in full ahead of the click, which
      // the menu now does when a pointer or finger lands on a link (IntentLink in Sidebar.tsx). At 180 a screen
      // hovered and opened two minutes later showed two-minute-old orders (seen in the local twin: hover, wait 40 s,
      // click, no request). 30 keeps one rule: nothing on screen is older than half a minute when it appears.
      static: 30,
    },
  },
};

export default nextConfig;
