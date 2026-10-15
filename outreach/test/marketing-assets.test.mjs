import test from "node:test";
import assert from "node:assert/strict";
import { publicImageURL, isPublicIPv4 } from "../marketing/assets.mjs";
test("remote image import refuses private networks, credentials, non-HTTPS and nonstandard ports", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
  ])
    assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  for (const url of [
    "http://example.com/a.png",
    "https://user:pass@example.com/a.png",
    "https://example.com:8443/a.png",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
  ])
    assert.throws(() => publicImageURL(url));
  assert.equal(
    publicImageURL("https://example.com/a.png").hostname,
    "example.com",
  );
});
