import {env} from './env';

export type GoogleClient = {clientId: string; clientSecret: string};

/**
 * The app's Google OAuth client, when one is set up: Google sign-in uses it (`auth/google.ts`), and
 * so does connecting a Google account (`connections/google/`), each with a redirect URI of its own.
 */
export function googleOAuthClient(): GoogleClient | null {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return null;
	}

	return {clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET};
}
