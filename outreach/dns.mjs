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
const invalid = (values, extra = {}) => ({
  status: "invalid",
  values: bounded(values),
  error: "Запись найдена, но не может использоваться для почты",
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
  const timeoutMs = Math.max(100, Math.min(10000, options.timeoutMs || 10000));
  const withTimeout = (promise, extra = {}) =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(failure({ code: "ETIMEOUT" }, extra)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          resolve(failure(error, extra));
        },
      );
    });
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
      const ordered = rows.sort((a, b) => a.priority - b.priority);
      const values = ordered.map(
        (row) => `${row.priority} ${row.exchange || "."}`,
      );
      return ordered.length && ordered.every((row) => !row.exchange)
        ? invalid(values)
        : status(values);
    } catch (error) {
      return failure(error);
    }
  })();
  const spfPromise = txt(resolver, domain, "v=spf1");
  const dmarcPromise = txt(resolver, `_dmarc.${domain}`, "v=dmarc1");
  const dkimPromise = (async () => {
    let unavailable = false;
    let invalidResult = null;
    for (const selector of selectors) {
      const result = await txt(
        resolver,
        `${selector}._domainkey.${domain}`,
        "v=dkim1",
      );
      if (result.status === "ok") {
        const usable = result.values.some((value) =>
          /(?:^|;)\s*p\s*=\s*[^;\s]+/i.test(value),
        );
        if (usable) return { ...result, selector };
        invalidResult ||= invalid(result.values, { selector });
      }
      unavailable ||= result.status === "unavailable";
    }
    if (invalidResult) return invalidResult;
    return {
      status: unavailable ? "unavailable" : "missing",
      values: [],
      error: unavailable ? "DNS-проверка временно недоступна" : "",
      selector: "",
    };
  })();
  const [mx, spf, dmarc, dkim] = await Promise.all([
    withTimeout(mxPromise),
    withTimeout(spfPromise),
    withTimeout(dmarcPromise),
    withTimeout(dkimPromise, { selector: "" }),
  ]);
  return {
    domain,
    checkedAt: (options.now || Date.now)(),
    mx,
    spf,
    dmarc,
    dkim,
  };
}
