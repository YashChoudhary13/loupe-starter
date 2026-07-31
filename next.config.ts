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
      static: 180,
    },
  },
};

export default nextConfig;
