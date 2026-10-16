import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("Store waits for an existing database writer before startup pragmas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dmailio-startup-"));
  const path = join(dir, "startup.sqlite");
  const store = new Store(path, "a".repeat(64));
  const source = `import { Store } from ${JSON.stringify(new URL("../store.mjs", import.meta.url).href)};const s=new Store(process.env.TEST_DB,"a".repeat(64));s.close();console.log("opened");`;
  store.db.exec(
    "PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE runtime_lock SET expires=0;",
  );
  let released = false;
  const release = () => {
    if (!released) {
      store.db.exec("ROLLBACK");
      released = true;
    }
  };
  const timer = setTimeout(release, 1000);
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", source],
      { env: { ...process.env, TEST_DB: path } },
    );
    assert.equal(result.stdout.trim(), "opened");
    assert.equal(released, true);
  } finally {
    clearTimeout(timer);
    release();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
