/**
 * Token-refresh logic and the `ensureFreshToken` API used at agent
 * spawn time. All concurrent calls for the same server name share one
 * refresh round-trip via the secrets-vault key mutex.
 */

import { withKeyMutex } from '../secrets-vault.js';
import { refreshAccessToken } from './flow.js';
import {
  readOAuthRecord,
  readOAuthSealed,
  writeOAuthRecord,
} from './storage.js';
import type { OAuthSealed } from './types.js';

/** Refresh if the token expires within this many seconds. */
const REFRESH_LEEWAY_SECONDS = 60;

export interface FreshToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export class OAuthRecordMissingError extends Error {
  constructor(public readonly serverName: string) {
    super(`No OAuth record for MCP server "${serverName}"`);
  }
}

export class OAuthRefreshError extends Error {
  constructor(public readonly serverName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to refresh OAuth token for "${serverName}": ${reason}`);
  }
}

/**
 * Read the vault record, refresh if near expiry, and return a live
 * access token.
 *
 * Writes back the rotated record atomically. Concurrent callers for
 * the same server name share one refresh.
 */
export async function ensureFreshToken(serverName: string, now = Date.now()): Promise<FreshToken> {
  return withKeyMutex(`oauth:${serverName}`, async () => {
    const record = await readOAuthRecord(serverName);
    if (!record) throw new OAuthRecordMissingError(serverName);

    const nowSec = Math.floor(now / 1000);
    if (record.expires_at - nowSec > REFRESH_LEEWAY_SECONDS) {
      const sealed = await readOAuthSealed(record);
      return {
        accessToken: sealed.access_token,
        tokenType: sealed.token_type,
        expiresAt: record.expires_at,
      };
    }

    const sealed = await readOAuthSealed(record);
    if (!sealed.refresh_token) {
      throw new OAuthRefreshError(serverName, new Error('No refresh_token stored — reconnect required'));
    }

    let response;
    try {
      response = await refreshAccessToken({
        tokenEndpoint: record.token_endpoint,
        refreshToken: sealed.refresh_token,
        clientId: sealed.client_id,
        clientSecret: sealed.client_secret,
        scope: record.scopes.length ? record.scopes.join(' ') : undefined,
      });
    } catch (err) {
      throw new OAuthRefreshError(serverName, err);
    }

    const refreshedSealed: OAuthSealed = {
      access_token: response.access_token,
      refresh_token: response.refresh_token ?? sealed.refresh_token,
      client_id: sealed.client_id,
      client_secret: sealed.client_secret,
      token_type: response.token_type,
    };

    const expiresAt = response.expires_in
      ? nowSec + response.expires_in
      : record.expires_at; // unknown lifetime — leave as-is so we re-try next time

    await writeOAuthRecord(
      {
        ...record,
        updated_at: nowSec,
        expires_at: expiresAt,
        token_endpoint: record.token_endpoint,
        scopes: record.scopes,
      },
      refreshedSealed,
    );

    return {
      accessToken: response.access_token,
      tokenType: response.token_type,
      expiresAt,
    };
  });
}
