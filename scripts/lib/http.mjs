// One polite HTTP client for every fetcher.

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 sunset.dearcrisis.com-calendar";

export async function get(url, { accept = "*/*", timeout = 25000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept, ...headers },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function getJson(url, opts = {}) {
  return JSON.parse(await get(url, { accept: "application/json", ...opts }));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
