import assert from "node:assert/strict";
import test from "node:test";

import { moveScreenItem } from "./screen-layout-state.ts";

test("moving an app onto an occupied screen swaps both apps", () => {
  const layout = { left: ["app:github"], down: ["app:codex"], right: ["app:gmail"] };

  assert.deepEqual(moveScreenItem(layout, "app:github", "right"), {
    left: ["app:gmail"],
    down: ["app:codex"],
    right: ["app:github"],
  });
});
