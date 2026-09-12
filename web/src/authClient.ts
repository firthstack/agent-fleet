import { createAuthClient } from "better-auth/react";

/**
 * Same origin as the API, so the session cookie the gateway sets is the one
 * every request carries — no token juggling in the browser, and nothing
 * sensitive in localStorage.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export const { useSession, signIn, signUp, signOut } = authClient;
