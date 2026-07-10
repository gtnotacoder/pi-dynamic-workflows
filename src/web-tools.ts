/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox, so they perform
 * genuine HTTP requests via Node's fetch.
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a public URL and return readable text (HTML stripped, truncated)
 *
 * Every request and redirect rejects local/private/non-public targets, then
 * connects to an already-validated address so DNS cannot rebind the request.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export type WebHostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface PinnedWebResponse {
  status: number;
  body: string;
  location?: string;
}

export type PinnedWebRequester = (
  url: URL,
  address: string,
  family: number,
  signal: AbortSignal,
) => Promise<PinnedWebResponse>;

interface ResolvedWebTarget {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

const MAX_RESPONSE_BYTES = 1_000_000;
const defaultResolver: WebHostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

function isPublicIpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 88 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicIpAddress(normalized.slice("::ffff:".length));
    // Conservatively allow only globally routed unicast space (2000::/3),
    // excluding the documentation prefix.
    return /^[23]/.test(normalized) && !normalized.startsWith("2001:db8:");
  }
  return false;
}

async function resolvePublicHttpUrl(rawUrl: string, resolver: WebHostResolver): Promise<ResolvedWebTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid web URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Only credential-free public HTTP(S) URLs are allowed");
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Private or local web targets are not allowed");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(hostname)) throw new Error("Private or non-public IP targets are not allowed");
    return { url: parsed, addresses: [{ address: hostname, family: literalFamily }] };
  }
  if (!hostname.includes(".")) throw new Error("Single-label web targets are not allowed");
  const resolved = await resolver(hostname);
  if (resolved.length === 0 || resolved.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("Web target resolves to a private or non-public address");
  }
  const addresses = [...new Map(resolved.map(({ address }) => [address, { address, family: isIP(address) }])).values()];
  return { url: parsed, addresses };
}

const defaultPinnedRequester: PinnedWebRequester = (url, address, family, signal) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const originalHostname = url.hostname.replace(/^\[|\]$/g, "");
    const req = request(
      {
        protocol: url.protocol,
        hostname: address,
        family,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, "user-agent": UA },
        signal,
        ...(url.protocol === "https:" && !isIP(originalHostname) ? { servername: originalHostname } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const rawLocation = response.headers.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, body: "", location });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`Web response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });

async function requestResolvedTarget(
  target: ResolvedWebTarget,
  signal: AbortSignal,
  requester: PinnedWebRequester,
): Promise<PinnedWebResponse> {
  let lastError: unknown;
  for (const { address, family } of target.addresses) {
    try {
      return await requester(target.url, address, family, signal);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No validated web address was reachable");
}

async function fetchText(
  url: string,
  timeoutMs = 15000,
  resolver: WebHostResolver = defaultResolver,
  requester: PinnedWebRequester = defaultPinnedRequester,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = await resolvePublicHttpUrl(current.toString(), resolver);
      const response = await requestResolvedTarget(target, controller.signal, requester);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) return { status: response.status, body: "" };
        current = new URL(response.location, current);
        continue;
      }
      return { status: response.status, body: response.body };
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBingResults(html: string, limit: number): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    if (/\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export function createWebSearchTool(): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return a list of result URLs and titles. Use before web_fetch to find sources.",
    promptSnippet: "Search the web for sources",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
    }),
    async execute(_id, params: { query: string; count?: number }) {
      const limit = Math.min(Math.max(params.count ?? 6, 1), 10);
      try {
        const { status, body } = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(params.query)}`);
        const results = parseBingResults(body, limit);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
          : `No results parsed (HTTP ${status}). Try a different query or fetch a known URL directly.`;
        return { content: [{ type: "text", text }], details: { results } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `web_search failed: ${error instanceof Error ? error.message : error}` }],
          details: { results: [] as Array<{ url: string; title: string }> },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** A tool that fetches a URL and returns readable text. */
export function createWebFetchTool(maxChars = 6000): ToolDefinition {
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its readable text content (HTML stripped, truncated).",
    promptSnippet: "Fetch a URL's text",
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch." }),
    }),
    async execute(_id, params: { url: string }) {
      try {
        const { status, body } = await fetchText(params.url);
        const text = htmlToText(body).slice(0, maxChars);
        return {
          content: [{ type: "text", text: `HTTP ${status} ${params.url}\n\n${text}` }],
          details: { status, url: params.url },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `web_fetch failed for ${params.url}: ${error instanceof Error ? error.message : error}`,
            },
          ],
          details: { status: 0, url: params.url },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** Re-fetch a citation host-side before it is accepted into a research artifact. */
export async function verifyWebCitation(
  url: string,
  resolver: WebHostResolver = defaultResolver,
  requester: PinnedWebRequester = defaultPinnedRequester,
): Promise<boolean> {
  try {
    const { status, body } = await fetchText(url, 15000, resolver, requester);
    return status >= 200 && status < 400 && body.trim().length > 0;
  } catch {
    return false;
  }
}

/** Both web tools, for injecting into a research workflow's agents. */
export function createWebTools(): ToolDefinition[] {
  return [createWebSearchTool(), createWebFetchTool()];
}
