import * as dns from "node:dns/promises";
import { domainToASCII } from "node:url";

const missingCodes = new Set(["ENODATA", "ENOTFOUND", "ENOENT"]);
const bounded = (values) => {
  const output = [];
  let size = 0;
  for (const raw of values) {
    const value = String(raw).slice(0, 4000);
    if (output.length >= 20 || size + value.length > 4000) break;
    output.push(value);
    size += value.length;
  }
  return output;
};
const status = (values, extra = {}) => ({
  status: values.length ? "ok" : "missing",
  values: bounded(values),
  error: "",
  ...extra,
});
const failure = (error, extra = {}) => ({
  status: missingCodes.has(error?.code) ? "missing" : "unavailable",
  values: [],
  error: missingCodes.has(error?.code)
    ? ""
    : "DNS-проверка временно недоступна",
  ...extra,
});
const txt = async (resolver, name, prefix) => {
  try {
    const rows = await resolver.resolveTxt(name);
    const values = rows
      .map((parts) => parts.join(""))
      .filter((value) => value.toLowerCase().startsWith(prefix));
    return status(values);
  } catch (error) {
    return failure(error);
  }
};

export async function checkDomainDNS(address, options = {}) {
  const match = String(address || "")
    .trim()
    .match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) throw new Error("Email is invalid");
  const domain = domainToASCII(match[1].toLowerCase());
  if (!domain) throw new Error("Email is invalid");
  const resolver = options.resolver || dns;
  const selectors = [
    ...new Set(
      (options.selectors?.length
        ? options.selectors
        : ["default", "google", "selector1", "selector2"]
      ).filter((value) => /^[a-z0-9_-]{1,63}$/i.test(value)),
    ),
  ];
  const mxPromise = (async () => {
    try {
      const rows = await resolver.resolveMx(domain);
      return status(
        rows
          .sort((a, b) => a.priority - b.priority)
          .map((row) => `${row.priority} ${row.exchange}`),
      );
    } catch (error) {
      return failure(error);
    }
  })();
  const spfPromise = txt(resolver, domain, "v=spf1");
  const dmarcPromise = txt(resolver, `_dmarc.${domain}`, "v=dmarc1");
  const dkimPromise = (async () => {
    let unavailable = false;
    for (const selector of selectors) {
      const result = await txt(
        resolver,
        `${selector}._domainkey.${domain}`,
        "v=dkim1",
      );
      if (result.status === "ok") return { ...result, selector };
      unavailable ||= result.status === "unavailable";
    }
    return {
      status: unavailable ? "unavailable" : "missing",
      values: [],
      error: unavailable ? "DNS-проверка временно недоступна" : "",
      selector: "",
    };
  })();
  const timeoutMs = Math.max(100, Math.min(10000, options.timeoutMs || 10000));
  const checks = Promise.all([
    mxPromise,
    spfPromise,
    dmarcPromise,
    dkimPromise,
  ]);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve([
          failure({ code: "ETIMEOUT" }),
          failure({ code: "ETIMEOUT" }),
          failure({ code: "ETIMEOUT" }),
          { ...failure({ code: "ETIMEOUT" }), selector: "" },
        ]),
      timeoutMs,
    );
  });
  const [mx, spf, dmarc, dkim] = await Promise.race([checks, timeout]);
  clearTimeout(timer);
  return {
    domain,
    checkedAt: (options.now || Date.now)(),
    mx,
    spf,
    dmarc,
    dkim,
  };
}
