
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const CAIP10_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;
const CAIP19_RE =
  /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}(\/[-.%a-zA-Z0-9]{1,78})?$/;

const POSITIVE_DECIMAL_RE = /^[1-9][0-9]{0,77}$/;

export function isCaip2(s: string): boolean {
  return typeof s === "string" && CAIP2_RE.test(s);
}

export function isCaip10(s: string): boolean {
  return typeof s === "string" && CAIP10_RE.test(s);
}

export function isCaip19(s: string): boolean {
  return typeof s === "string" && CAIP19_RE.test(s);
}

export function isPositiveDecimalString(s: string): boolean {
  return typeof s === "string" && POSITIVE_DECIMAL_RE.test(s);
}

export function compareDecimalStrings(a: string, b: string): number | null {
  if (!isPositiveDecimalString(a) || !isPositiveDecimalString(b)) return null;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function caip2Of(caip10OrCaip19: string): string | null {
  if (typeof caip10OrCaip19 !== "string") return null;
  if (isCaip19(caip10OrCaip19)) {
    const chain = caip10OrCaip19.slice(0, caip10OrCaip19.indexOf("/"));
    return isCaip2(chain) ? chain : null;
  }
  if (isCaip10(caip10OrCaip19)) {
    const parts = caip10OrCaip19.split(":");
    const chain = `${parts[0]}:${parts[1]}`;
    return isCaip2(chain) ? chain : null;
  }
  return null;
}
