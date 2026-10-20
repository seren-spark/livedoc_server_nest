import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    const a = p[0]!,
      b = p[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) !== 6) return false;
  const expanded = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const parts = expanded.split("::");
  const left = parts[0] ? parts[0].split(":").map((v) => parseInt(v, 16)) : [];
  const right = parts[1] ? parts[1].split(":").map((v) => parseInt(v, 16)) : [];
  const words =
    parts.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
      : left;
  if (words.length !== 8) return false;
  if (words.slice(0, 5).every((v) => v === 0) && words[5] === 0xffff)
    return isPublicAddress(
      `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`,
    );
  // Only global unicast; also exclude documentation, translation and transition ranges.
  return (
    words[0]! >= 0x2000 &&
    words[0]! < 0x4000 &&
    words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1]! <= 0x01ff || words[1] === 0xdb8))
  );
}
export async function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("仅允许公网 HTTP/HTTPS 地址");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("拒绝私网、回环或保留地址");
  return { url, address: addresses[0]!, addresses };
}
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, n, text) => `\n\n${"#".repeat(Number(n))} ${text}\n\n`,
    )
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|section|article|tr|ul|ol)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n) =>
      Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "",
    )
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function fetchPublicPage(
  input: string,
  signal?: AbortSignal,
): Promise<{ url: string; markdown: string }> {
  let next = input;
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal?.throwIfAborted();
    const { url, address, addresses } = await validatePublicUrl(next);
    const result = await new Promise<{
      location?: string;
      body: string;
      type: string;
    }>((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(
        url,
        {
          method: "GET",
          signal,
          timeout: 15000,
          headers: {
            "User-Agent": "LiveDoc/1.0",
            Accept: "text/html,text/plain,text/markdown",
          },
          lookup: ((_host: any, options: any, callback: any) =>
            options?.all
              ? callback(null, addresses)
              : callback(null, address.address, address.family)) as any,
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            resolve({
              location: new URL(res.headers.location, url).href,
              body: "",
              type: "",
            });
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            res.resume();
            reject(new Error(`网页响应 ${res.statusCode}`));
            return;
          }
          const type = String(res.headers["content-type"] ?? "");
          if (
            !/text\/(?:html|plain|markdown)|application\/xhtml\+xml/i.test(type)
          ) {
            res.resume();
            reject(new Error("只支持文字网页"));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024)
              req.destroy(new Error("网页超过 2 MiB"));
            else chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({ body: Buffer.concat(chunks).toString("utf8"), type }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("网页抓取超时")));
      req.on("error", reject);
      req.end();
    });
    if (result.location) {
      next = result.location;
      continue;
    }
    return {
      url: url.href,
      markdown: /html/i.test(result.type)
        ? htmlToMarkdown(result.body)
        : result.body,
    };
  }
  throw new Error("网页重定向次数过多");
}
