import assert from "node:assert/strict";
import test from "node:test";

import { humanizeRuleError, toggleValue } from "./rule-builder-chat-state";

test("rule chat state keeps multi-select answers stable and explains recoverable errors", () => {
  assert.deepEqual(toggleValue([], "repo-a"), ["repo-a"]);
  assert.deepEqual(toggleValue(["repo-a", "repo-b"], "repo-a"), ["repo-b"]);
  assert.match(humanizeRuleError("ai settings required"), /AI settings/);
  assert.match(humanizeRuleError("rule session expired"), /seven days/);
});
