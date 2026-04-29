/**
 * RFC 7591 Dynamic Client Registration.
 *
 * Issues a POST against the authorization server's registration_endpoint
 * announcing the redirect URI we'll use, and returns the credentials the
 * server hands back. If the server returns 4xx for non-DCR reasons (no
 * support, manual approval required, etc.), the caller is expected to
 * surface a clear error and offer the manual `--client-id`/`--client-secret`
 * fallback.
 */

import type { RegisteredClient } from './types.js';

export interface DcrRequest {
  redirectUri: string;
  /** Client name shown to admins on consent screens. */
  clientName?: string;
  /** Scope string (space-separated) or omitted to let the server choose. */
  scope?: string;
  /** Optional homepage URL. */
  clientUri?: string;
}

export async function registerClient(
  registrationEndpoint: string,
  req: DcrRequest,
): Promise<RegisteredClient> {
  const body: Record<string, unknown> = {
    redirect_uris: [req.redirectUri],
    client_name: req.clientName ?? 'archie-hq',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    application_type: 'web',
  };
  if (req.scope) body.scope = req.scope;
  if (req.clientUri) body.client_uri = req.clientUri;

  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = await res.text();
      if (errBody) detail += `: ${errBody.slice(0, 500)}`;
    } catch {}
    throw new Error(`Dynamic Client Registration failed at ${registrationEndpoint}: ${detail}`);
  }

  const raw = (await res.json()) as Record<string, unknown>;
  if (typeof raw.client_id !== 'string') {
    throw new Error(`DCR response from ${registrationEndpoint} is missing client_id`);
  }

  return {
    client_id: raw.client_id,
    client_secret: typeof raw.client_secret === 'string' ? raw.client_secret : undefined,
    client_secret_expires_at: typeof raw.client_secret_expires_at === 'number'
      ? raw.client_secret_expires_at
      : undefined,
    registration_client_uri: typeof raw.registration_client_uri === 'string'
      ? raw.registration_client_uri
      : undefined,
    registration_access_token: typeof raw.registration_access_token === 'string'
      ? raw.registration_access_token
      : undefined,
    raw,
  };
}
