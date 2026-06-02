const assert = require("node:assert/strict");
const test = require("node:test");

const { enqueuePipelineRun, getPipelineQueueState } = require("../src/pipeline/pipelineQueue");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("pipeline queue runs only one pipeline at a time and preserves order", async () => {
  const events = [];
  const queued = [];

  const first = enqueuePipelineRun("outreach", "first", async () => {
    events.push("first:start");
    assert.equal(getPipelineQueueState().activeRun.label, "first");
    await sleep(30);
    events.push("first:end");
    return "one";
  });

  const second = enqueuePipelineRun(
    "content",
    "second",
    async () => {
      events.push("second:start");
      assert.equal(getPipelineQueueState().activeRun.label, "second");
      events.push("second:end");
      return "two";
    },
    { onQueued: (info) => queued.push(info) },
  );

  assert.equal(await first, "one");
  assert.equal(await second, "two");
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].position, 1);
  assert.equal(getPipelineQueueState().activeRun, null);
  assert.equal(getPipelineQueueState().queuedCount, 0);
});
