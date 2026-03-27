import assert from "node:assert/strict";
import test from "node:test";

import { readNodeEnvFlag } from "../../src/common/env.js";

test("readNodeEnvFlag treats missing keys as disabled", () => {
  const key = "CARTA_TEST_READ_NODE_ENV_FLAG_MISSING";
  const previousValue = process.env[key];
  delete process.env[key];

  assert.equal(readNodeEnvFlag(key), false);

  if (previousValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previousValue;
  }
});

test('readNodeEnvFlag treats "1"/"true" as enabled', () => {
  const key = "CARTA_TEST_READ_NODE_ENV_FLAG_ENABLED";
  const previousValue = process.env[key];

  process.env[key] = "1";
  assert.equal(readNodeEnvFlag(key), true);

  process.env[key] = "true";
  assert.equal(readNodeEnvFlag(key), true);

  process.env[key] = " yes ";
  assert.equal(readNodeEnvFlag(key), true);

  process.env[key] = "on";
  assert.equal(readNodeEnvFlag(key), true);

  if (previousValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previousValue;
  }
});

test('readNodeEnvFlag treats "0"/"false" as disabled', () => {
  const key = "CARTA_TEST_READ_NODE_ENV_FLAG_DISABLED";
  const previousValue = process.env[key];

  process.env[key] = "0";
  assert.equal(readNodeEnvFlag(key), false);

  process.env[key] = "false";
  assert.equal(readNodeEnvFlag(key), false);

  process.env[key] = " off ";
  assert.equal(readNodeEnvFlag(key), false);

  process.env[key] = "no";
  assert.equal(readNodeEnvFlag(key), false);

  if (previousValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previousValue;
  }
});
