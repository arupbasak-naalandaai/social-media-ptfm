import { defineConfig } from "tsdown"

// Bundle workspace packages (they ship TypeScript source); keep npm deps external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  noExternal: [/^@inbox\//],
})
