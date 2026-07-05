/**
 * SessionTokenService port (M7.1) — mints opaque bearer tokens and derives the
 * hash stored at rest. Core never sees the raw crypto. `issue()` returns the token
 * to hand the client plus the hash to persist; `hash()` re-derives it for lookup.
 */
export interface IssuedToken {
  /** Given to the client once; never stored. */
  readonly token: string;
  /** Stored server-side (sessions.token_hash). */
  readonly tokenHash: string;
}

export interface SessionTokenService {
  issue(): IssuedToken;
  hash(token: string): string;
}
