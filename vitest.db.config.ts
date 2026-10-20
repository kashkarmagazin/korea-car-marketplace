import { defineConfig } from "vitest/config";

// Baza testlari: haqiqiy PostgreSQL 15 + migratsiyalar. Fayllar ketma-ket ishlaydi (bitta server).
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
