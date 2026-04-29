/**
 * OAuth discovery primitives.
 *
 * - Probes an MCP server URL for `WWW-Authenticate: Bearer
 *   resource_metadata="<url>"` (RFC 9728 §5.1).
 * - Fetches RFC 9728 protected-resource metadata.
 * - Fetches RFC 8414 authorization-server metadata (with the OIDC
 *   `.well-known/openid-configuration` fallback that some servers still
 *   advertise instead).
 *
 * Pure HTTP, zero per-server knowledge.
 */

import type { AuthServerMetadata, ProtectedResourceMetadata } from './types.js';

const ACCEPT_JSON = { Accept: 'application/json' } as const;

/**
 * Issue a GET against the MCP server URL and parse the
 * `WWW-Authenticate` header for a `resource_metadata` parameter.
 *
 * Returns null if the server didn't return a 401 with that header.
 */
export async function probeResourceMetadataUrl(serverUrl: string): Promise<string | null> {
  const res = await fetch(serverUrl, {
    method: 'GET',
    headers: { Accept: 'application/json, text/event-stream' },
  });
  // Drain the body so we don't leak the response (Node `fetch` requires
  // either consuming or cancelling the stream).
  await res.body?.cancel().catch(() => {});

  const header = res.headers.get('www-authenticate');
  if (!header) return null;
  return parseResourceMetadataParam(header);
}

/**
 * Parse `WWW-Authenticate` header values for the first `resource_metadata`
 * parameter. The header may contain multiple challenges separated by
 * commas; we accept any Bearer challenge.
 */
export function parseResourceMetadataParam(header: string): string | null {
  // Look for `resource_metadata="<url>"` or `resource_metadata=<url>`.
  // The grammar is auth-param = token "=" ( token / quoted-string ).
  const match = header.match(/resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Fetch RFC 9728 protected-resource metadata.
 */
export async function fetchProtectedResourceMetadata(url: string): Promise<ProtectedResourceMetadata> {
  const res = await fetch(url, { headers: ACCEPT_JSON });
  if (!res.ok) {
    throw new Error(`Failed to fetch protected-resource metadata at ${url}: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    resource: typeof raw.resource === 'string' ? raw.resource : '',
    authorization_servers: Array.isArray(raw.authorization_servers)
      ? (raw.authorization_servers as string[]).filter((s) => typeof s === 'string')
      : undefined,
    scopes_supported: Array.isArray(raw.scopes_supported)
      ? (raw.scopes_supported as string[]).filter((s) => typeof s === 'string')
      : undefined,
    raw,
  };
}

/**
 * Fetch RFC 8414 authorization-server metadata for the given issuer URL.
 *
 * Tries `<issuer>/.well-known/oauth-authorization-server` first, then
 * falls back to `<issuer>/.well-known/openid-configuration` for OIDC
 * issuers that don't advertise the OAuth document.
 */
export async function fetchAuthServerMetadata(issuer: string): Promise<AuthServerMetadata> {
  const candidates = wellKnownCandidates(issuer);
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: ACCEPT_JSON });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} at ${url}`);
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      const metadata = parseAuthServerMetadata(raw);
      validateAuthServerMetadata(metadata, url);
      return metadata;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not fetch authorization-server metadata from ${issuer}: ${stringifyError(lastError)}`
  );
}

function wellKnownCandidates(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, '');
  return [
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${trimmed}/.well-known/openid-configuration`,
  ];
}

function parseAuthServerMetadata(raw: Record<string, unknown>): AuthServerMetadata {
  return {
    issuer: typeof raw.issuer === 'string' ? raw.issuer : '',
    authorization_endpoint: typeof raw.authorization_endpoint === 'string' ? raw.authorization_endpoint : '',
    token_endpoint: typeof raw.token_endpoint === 'string' ? raw.token_endpoint : '',
    registration_endpoint: typeof raw.registration_endpoint === 'string' ? raw.registration_endpoint : undefined,
    scopes_supported: stringArray(raw.scopes_supported),
    response_types_supported: stringArray(raw.response_types_supported),
    grant_types_supported: stringArray(raw.grant_types_supported),
    code_challenge_methods_supported: stringArray(raw.code_challenge_methods_supported),
    token_endpoint_auth_methods_supported: stringArray(raw.token_endpoint_auth_methods_supported),
    raw,
  };
}

function validateAuthServerMetadata(m: AuthServerMetadata, source: string): void {
  if (!m.authorization_endpoint) {
    throw new Error(`Authorization-server metadata at ${source} is missing authorization_endpoint`);
  }
  if (!m.token_endpoint) {
    throw new Error(`Authorization-server metadata at ${source} is missing token_endpoint`);
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return 'unknown error';
  return String(err);
}
