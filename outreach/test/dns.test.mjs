import test from "node:test";
import assert from "node:assert/strict";
import { checkDomainDNS } from "../dns.mjs";

test("DNS diagnostics normalize MX, SPF, DMARC and DKIM", async () => {
  const resolver = {
    resolveMx: async () => [{ priority: 10, exchange: "mx.example.com" }],
    resolveTxt: async (name) =>
      name === "example.com"
        ? [["v=spf1 include:_spf.example.com -all"]]
        : name === "_dmarc.example.com"
          ? [["v=DMARC1; p=quarantine"]]
          : [["v=DKIM1; k=rsa; p=abc"]],
  };
  const result = await checkDomainDNS("sender@example.com", {
    resolver,
    selectors: ["default"],
    now: () => 123,
  });
  assert.equal(result.domain, "example.com");
  assert.deepEqual(result.mx.values, ["10 mx.example.com"]);
  assert.equal(result.mx.status, "ok");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "ok");
  assert.equal(result.dkim.status, "ok");
  assert.equal(result.dkim.selector, "default");
  assert.equal(result.checkedAt, 123);
});

test("one failed DNS lookup does not hide successful records", async () => {
  const resolver = {
    resolveMx: async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    },
    resolveTxt: async (name) =>
      name === "example.com" ? [["v=spf1 -all"]] : [],
  };
  const result = await checkDomainDNS("sender@example.com", { resolver });
  assert.equal(result.mx.status, "unavailable");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "missing");
  assert.equal(result.dkim.status, "missing");
});

test("DNS diagnostics reject non-email input and bound rendered records", async () => {
  await assert.rejects(() => checkDomainDNS("not-an-email"), /email/i);
  const resolver = {
    resolveMx: async () =>
      Array.from({ length: 30 }, (_, i) => ({
        priority: i,
        exchange: `${"x".repeat(300)}-${i}.example.com`,
      })),
    resolveTxt: async () => [],
  };
  const result = await checkDomainDNS("sender@example.com", { resolver });
  assert.ok(result.mx.values.length <= 20);
  assert.ok(result.mx.values.join("").length <= 4000);
});

test("DNS diagnostics do not report null MX or revoked DKIM as healthy", async () => {
  const resolver = {
    resolveMx: async () => [{ priority: 0, exchange: "" }],
    resolveTxt: async (name) =>
      name === "example.com"
        ? [["v=spf1 -all"]]
        : name === "_dmarc.example.com"
          ? [["v=DMARC1; p=reject"]]
          : [["v=DKIM1; p="]],
  };
  const result = await checkDomainDNS("sender@example.com", {
    resolver,
    selectors: ["default"],
  });
  assert.equal(result.mx.status, "invalid");
  assert.equal(result.dkim.status, "invalid");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "ok");
});
