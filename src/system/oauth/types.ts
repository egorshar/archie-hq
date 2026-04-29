/**
 * Shared types for the OAuth subsystem.
 *
 * The vocabulary follows the relevant RFCs:
 *   - RFC 6749 / OAuth 2.1 — authorization code grant
 *   - RFC 7591 — Dynamic Client Registration
 *   - RFC 7636 — PKCE
 *   - RFC 8414 — Authorization Server Metadata
 *   - RFC 9728 — Protected Resource Metadata
 */

import type { EncryptedEnvelope } from '../secrets-vault.js';

/** Subset of RFC 8414 we care about. */
export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  /** Raw JSON body (kept so callers can inspect uncommon fields). */
  raw: Record<string, unknown>;
}

/** Subset of RFC 9728 we care about. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  raw: Record<string, unknown>;
}

/** Result of dynamic client registration. */
export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  /** RFC 7591 expiry in seconds; 0 means non-expiring. */
  client_secret_expires_at?: number;
  registration_client_uri?: string;
  registration_access_token?: string;
  raw: Record<string, unknown>;
}

/** Plaintext metadata in an OAuth vault record. */
export interface OAuthRecordMeta {
  server_name: string;
  label?: string;
  expires_at: number;        // unix seconds
  created_at: number;
  updated_at: number;
  token_endpoint: string;
  scopes: string[];
}

/** What we encrypt inside the OAuth vault record. */
export interface OAuthSealed {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret?: string;
  token_type: string;        // typically "Bearer"
}

/** On-disk representation of a connected MCP server. */
export interface OAuthRecord extends OAuthRecordMeta {
  envelope: EncryptedEnvelope;
}

/** What the CLI persists for the daemon's callback handler to pick up. */
export interface OAuthPendingMeta {
  state: string;
  server_name: string;
  label?: string;
  token_endpoint: string;
  authorization_endpoint: string;
  scopes: string[];
  redirect_uri: string;
  created_at: number;
}

/** Encrypted half of a pending file (verifier + client creds). */
export interface OAuthPendingSealed {
  code_verifier: string;
  client_id: string;
  client_secret?: string;
}

/** On-disk representation of an in-flight OAuth attempt. */
export interface OAuthPendingRecord extends OAuthPendingMeta {
  envelope: EncryptedEnvelope;
  /** Set by the callback handler when the exchange fails — CLI surfaces it. */
  error?: string;
  /** Set by the callback handler on success — CLI uses it to detect completion. */
  completed_at?: number;
}

/** Token response per RFC 6749 §5.1, plus optional fields we care about. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  raw: Record<string, unknown>;
}
