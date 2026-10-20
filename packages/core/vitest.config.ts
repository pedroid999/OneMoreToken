import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@omt/core",
    environment: "node",
  },
});
