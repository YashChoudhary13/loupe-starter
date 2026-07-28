import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // These tests talk to the real Supabase project. They are the point — a
    // mocked counter proves nothing about row locks. Give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The SKU counter tests mutate a shared counter row. Running files in
    // parallel would let them interfere with each other's assertions.
    fileParallelism: false,
  },
})
