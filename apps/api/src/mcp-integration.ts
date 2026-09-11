import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ValidationError } from "@acalys/contracts/domain";

export type McpAuthMethod = "none" | "api_key";

export interface McpServerRegistrationInput {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly guidance: string;
  readonly auth: McpAuthMethod;
  readonly apiKey?: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ValidatedMcpServer {
  readonly config: {
    readonly id: string;
    readonly label: string;
    readonly url: string;
    readonly guidance: string;
    readonly auth: McpAuthMethod;
    readonly headerNames: readonly string[];
  };
  readonly secret?: {
    readonly apiKey?: string | undefined;
    readonly headers: Readonly<Record<string, string>>;
  } | undefined;
}

export interface McpAddressResolver {
  (hostname: string): Promise<readonly string[]>;
}

const blockedHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "forwarded",
]);
const sensitiveQueryName = /(?:^|[-_.])(token|secret|password|passwd|api[-_.]?key|access[-_.]?token|auth|authorization)(?:$|[-_.])/iu;

function invalid(message: string): never {
  throw new ValidationError(message);
}

function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return numbers;
}

/** Conservative global-unicast check. Unknown/special ranges fail closed. */
export function isPublicMcpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = parseIpv4(address);
    if (octets === undefined) return false;
    const [a = 0, b = 0] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    if (a >= 224) return false;
    return true;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return false;
    if (value.startsWith("fc") || value.startsWith("fd")) return false;
    if (/^fe[89ab]/u.test(value)) return false;
    if (value.startsWith("ff")) return false;
    if (value.startsWith("2001:db8:")) return false;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mapped !== undefined) return isPublicMcpAddress(mapped);
    return true;
  }
  return false;
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

export class McpIntegrationService {
  public constructor(private readonly resolveAddresses: McpAddressResolver = defaultResolver) {}

  public async validateRegistration(input: McpServerRegistrationInput): Promise<ValidatedMcpServer> {
    const label = input.label.trim();
    if (label.length < 1 || label.length > 200) invalid("MCP server label is invalid");
    if (input.guidance.length > 10_000) invalid("MCP usage guidance is too long");

    let endpoint: URL;
    try { endpoint = new URL(input.url); }
    catch { invalid("MCP server URL is invalid"); }
    if (endpoint.protocol !== "https:") invalid("MCP server URL must use HTTPS");
    if (endpoint.username !== "" || endpoint.password !== "") invalid("MCP server URL must not contain credentials");
    if (endpoint.hash !== "") invalid("MCP server URL must not contain a fragment");
    if (endpoint.port !== "" && endpoint.port !== "443") invalid("MCP server URL must use the standard HTTPS port");

    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      isIP(hostname) !== 0
    ) invalid("MCP server hostname is not allowed");
    for (const [name, value] of endpoint.searchParams) {
      if (name.length > 200 || value.length > 2_000 || sensitiveQueryName.test(name)) {
        invalid("MCP server URL contains a disallowed query parameter");
      }
    }

    let addresses: readonly string[];
    try { addresses = await this.resolveAddresses(hostname); }
    catch { invalid("MCP server hostname could not be resolved"); }
    if (addresses.length === 0 || addresses.some((address) => !isPublicMcpAddress(address))) {
      invalid("MCP server hostname resolved to a non-public network address");
    }

    const headers: Record<string, string> = {};
    let headerBytes = 0;
    for (const [rawName, rawValue] of Object.entries(input.headers)) {
      const name = rawName.trim();
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) invalid("MCP header name is invalid");
      if (blockedHeaderNames.has(lower) || lower.startsWith("x-forwarded-")) invalid("MCP header is blocked");
      if (rawValue.includes("\r") || rawValue.includes("\n")) invalid("MCP header value contains a line break");
      if (rawValue.length > 4_096) invalid("MCP header value is too long");
      headerBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(rawValue, "utf8");
      if (headerBytes > 8_192) invalid("MCP headers exceed the 8KB limit");
      headers[name] = rawValue;
    }

    const apiKey = input.apiKey?.trim();
    if (input.auth === "api_key" && (apiKey === undefined || apiKey.length < 1 || apiKey.length > 8_192)) {
      invalid("MCP API key is required for API-key authentication");
    }
    if (input.auth === "none" && apiKey !== undefined && apiKey !== "") {
      invalid("MCP API key must be omitted when authentication is none");
    }

    endpoint.hostname = hostname;
    endpoint.username = "";
    endpoint.password = "";
    const secretHeaders = Object.keys(headers).length === 0 ? {} : headers;
    const hasSecret = input.auth === "api_key" || Object.keys(secretHeaders).length > 0;
    return {
      config: {
        id: input.id,
        label,
        url: endpoint.toString(),
        guidance: input.guidance,
        auth: input.auth,
        headerNames: Object.keys(headers).sort((a, b) => a.localeCompare(b)),
      },
      ...(hasSecret ? {
        secret: {
          ...(input.auth === "api_key" ? { apiKey } : {}),
          headers: secretHeaders,
        },
      } : {}),
    };
  }
}
