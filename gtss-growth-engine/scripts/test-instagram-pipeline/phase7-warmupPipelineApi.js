/**
 * T7 — Warmup Pipeline API
 *
 * Verifies GET /api/instagram/warmup-pipeline returns 200 with the expected
 * shape: a `stats` key, a `pipeline` key, and `pipeline` is an array.
 */

const assert = require("assert");

const { TEST_PORT } = require("./_setup");

/**
 * @param {{}} ctx (uses TEST_PORT from _setup, no shared state needed)
 */
async function runPhase7() {
  console.log("Running T7 — Warmup pipeline API...");
  const pipelineResponse = await fetch(
    `http://localhost:${TEST_PORT}/api/instagram/warmup-pipeline`,
  );
  assert.strictEqual(
    pipelineResponse.status,
    200,
    `GET Warmup-pipeline failed with status: ${pipelineResponse.status}`,
  );
  const pipelineData = await pipelineResponse.json();

  assert(
    pipelineData.stats !== undefined,
    "Warmup-pipeline shape assertion failed: missing 'stats' key.",
  );
  assert(
    pipelineData.pipeline !== undefined,
    "Warmup-pipeline shape assertion failed: missing 'pipeline' key.",
  );
  assert(
    Array.isArray(pipelineData.pipeline),
    "Warmup-pipeline shape assertion failed: 'pipeline' is not an array.",
  );
  console.log("✅ T7 Warmup pipeline API — PASS\n");
}

module.exports = { runPhase7 };
