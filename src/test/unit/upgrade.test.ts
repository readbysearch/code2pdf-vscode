import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Signs, cameFromVersion1 } from "../../upgrade";

const none: Signs = { noteShown: false, version1Settings: false, firstActivation: false, firstCommand: false, msSinceActivation: 60_000 };

test("version 1's settings mean a version 1 user", () => {
  assert.ok(cameFromVersion1({ ...none, version1Settings: true }));
});

test("a print that activated the extension for the first time ever: updated from version 1", () => {
  assert.ok(cameFromVersion1({ ...none, firstActivation: true, firstCommand: true, msSinceActivation: 40 }));
});

test("a fresh install: the walkthrough activated it earlier, so the first print comes later", () => {
  assert.ok(!cameFromVersion1({ ...none, firstActivation: true, firstCommand: true, msSinceActivation: 90_000 }));
  assert.ok(!cameFromVersion1({ ...none, firstActivation: true, firstCommand: false, msSinceActivation: 40 }));
  assert.ok(!cameFromVersion1({ ...none, firstActivation: false, firstCommand: true, msSinceActivation: 40 }), "activated before, on an earlier day");
});

test("never twice", () => {
  assert.ok(!cameFromVersion1({ ...none, noteShown: true, version1Settings: true, firstActivation: true, firstCommand: true, msSinceActivation: 40 }));
});
