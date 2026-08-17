import * as path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["./test/**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: [],
    globals: true,
    coverage: {
      provider: "v8"
    }
  },
  resolve: {
    alias: {
      "sarah-computer-controller": path.join(__dirname, "src")
    }
  }
})
