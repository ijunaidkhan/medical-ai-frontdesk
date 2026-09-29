import type { Role } from '@frontdesk/shared';

/** The verified identity of a request, taken only from a valid access token. */
export interface AuthContext {
  userId: string;
  /** The tenant this request acts in. */
  practiceId: string;
  role: Role;
  /** Refresh-token family id; identifies the login session. */
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by AccessTokenGuard on every non-public route. */
      auth?: AuthContext;
    }
  }
}
