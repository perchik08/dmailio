import test from "node:test";
import assert from "node:assert/strict";
import {
  countdownImage,
  remaining,
  CountdownCache,
} from "../marketing/countdown.mjs";
import { timerConfig, timerPath } from "../public/marketing/builder-blocks.js";
import gif from "omggif";
test("dynamic countdown uses an absolute instant across time zones and changes GIF pixels as time passes", () => {
  const config = timerConfig({
      deadline: "2026-12-31T18:00:00+03:00",
      timezone: "Europe/Moscow",
    }),
    utc = timerConfig({ deadline: "2026-12-31T15:00:00Z", timezone: "UTC" });
  assert.equal(config.deadline, utc.deadline);
  assert.equal(
    remaining(config, Date.parse("2026-12-31T14:59:00Z")),
    "00:00:01:00",
  );
  assert.equal(
    remaining(config, Date.parse("2027-01-01T00:00:00Z")),
    "00:00:00:00",
  );
  const before = countdownImage(config, Date.parse("2026-12-31T14:59:00Z")),
    after = countdownImage(config, Date.parse("2026-12-31T14:59:10Z"));
  assert.equal(before.subarray(0, 6).toString(), "GIF89a");
  assert.notDeepEqual(before, after);
  const reader = new gif.GifReader(before);
  assert.equal(reader.numFrames(), 60);
  assert.equal(reader.width, 330);
  assert.throws(() => timerConfig({ deadline: "2026-12-31T18:00:00" }));
  assert.throws(() => timerConfig({ ...config, timezone: "invalid" }));
  assert.match(timerPath(config), /\.gif$/);
  const cache = new CountdownCache();
  assert.equal(cache.get("/unknown", 0), null);
  const now = Date.parse("2026-12-31T14:59:00Z"),
    path = timerPath(config);
  for (let i = 0; i < 100; i++) assert.ok(cache.get(path, now));
  assert.throws(
    () => cache.get(path, now),
    (error) => error.status === 429,
  );
  assert.ok(cache.get(path, now + 1000));
});
