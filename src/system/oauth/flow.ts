/**
 * Generic OAuth 2.1 / PKCE primitives.
 *
 * - `generatePkcePair`: cryptographic verifier + S256 challenge.
 * - `generateState`: opaque state token (used as the pending-file key).
 * - `buildAuthorizeUrl`: assemble the authorize URL from
 *   discovered endpoints.
 * - `exchangeCodeForTokens` / `refreshAccessToken`: token-endpoint POSTs.
 *
 * No provider-specific logic — every quirk (e.g. issuer-specific extra
 * params) belongs in the calling layer, not here.
 */

import { createHash, randomBytes } from 'crypto';
import type { TokenResponse } from './types.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

const PKCE_VERIFIER_BYTES = 32; // → 43 base64url chars (RFC 7636 §4.1 minimum)

export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(PKCE_VERIFIER_BYTES));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  codeChallenge: string;
  /** Optional `resource` parameter (RFC 8707). */
  resource?: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.scope) url.searchParams.set('scope', input.scope);
  if (input.resource) url.searchParams.set('resource', input.resource);
  return url.toString();
}

export interface TokenExchangeInput {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}

export async function exchangeCodeForTokens(input: TokenExchangeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  if (input.resource) body.set('resource', input.resource);

  return postToTokenEndpoint(input.tokenEndpoint, body, input.clientId, input.clientSecret);
}

export interface RefreshInput {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
}

export async function refreshAccessToken(input: RefreshInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  if (input.scope) body.set('scope', input.scope);

  return postToTokenEndpoint(input.tokenEndpoint, body, input.clientId, input.clientSecret);
}

async function postToTokenEndpoint(
  endpoint: string,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string | undefined,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  // Many issuers prefer (or require) HTTP Basic for confidential clients.
  // We send credentials in the body too (above) for issuers that prefer that;
  // RFC 6749 §2.3.1 explicitly allows either.
  if (clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through with empty parsed; we'll surface text in the error
  }

  if (!res.ok) {
    const errorCode = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
    const errorDesc = typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : '';
    const fallback = !text || parsed.error ? '' : `: ${text.slice(0, 300)}`;
    throw new Error(`Token endpoint ${endpoint} returned ${errorCode}${errorDesc}${fallback}`);
  }

  if (typeof parsed.access_token !== 'string') {
    throw new Error(`Token endpoint ${endpoint} did not return an access_token`);
  }

  return {
    access_token: parsed.access_token,
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
    expires_in: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    raw: parsed,
  };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
