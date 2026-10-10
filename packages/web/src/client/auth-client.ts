import {httpRequest} from '@proxy/utils';
import {z} from 'zod';

// `POST /auth/email` answers 200 `{ok: true}`, with `logged` when the api wrote the link to its
// log for lack of a way to send email, or 4xx/5xx `{error}` with a code the login page maps to
// copy. Any status is accepted so the error body survives.
const magicLinkResponseSchema = z.object({
	ok: z.boolean().optional(),
	logged: z.boolean().optional(),
	error: z.string().optional(),
});

/**
 * Requests a magic-link email. Pre-auth, so no session cookie; the api still requires the app's
 * Origin (CSRF guard), which the browser attaches.
 */
export function requestMagicLink(email: string, callbackUrl?: string) {
	return httpRequest(
		'/auth/email',
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({email, ...(callbackUrl ? {callbackUrl} : {})}),
		},
		{schema: magicLinkResponseSchema, allowStatus: () => true},
	);
}

const signInMethodsSchema = z.object({
	password: z.boolean(),
	email: z.boolean(),
	google: z.boolean(),
	dev: z.boolean(),
});

export type SignInMethods = z.infer<typeof signInMethodsSchema>;

/** The sign-in methods allowed by the server's configured authentication mode. */
export function getSignInMethods() {
	return httpRequest('/auth/methods', {method: 'GET'}, {schema: signInMethodsSchema});
}

/** Owner sign-in uses the ordinary human session cookie, never browser-stored credentials. */
export function passwordSignIn(username: string, password: string, signal: AbortSignal) {
	return httpRequest(
		'/auth/password',
		{
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username, password}),
			signal,
		},
		{
			schema: z.union([z.object({ok: z.literal(true)}), z.object({error: z.string()})]),
			allowStatus: (status) => status === 200 || status === 401 || status === 429,
			timeoutMs: 15_000,
		},
	);
}

/** The full-page navigation that starts Google sign-in; the api redirects back when done. */
export function googleSignInUrl(callbackUrl?: string): string {
	const query = callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : '';
	return `/auth/google${query}`;
}

/**
 * Deletes the session and clears its cookie, then reloads: the reloaded page finds no session
 * and its guard sends the user to /login. Reloads even if the request failed, at worst leaving
 * them signed in where they were.
 */
export async function signOut(): Promise<void> {
	const result = await httpRequest('/auth/signout', {
		method: 'POST',
	});
	if (result.isErr()) {
		console.warn('Sign-out request failed', result.error.kind);
	}

	window.location.reload();
}

/** Dev only: creates a throwaway user and signs in as them. The api 404s outside development. */
export function devLogin() {
	return httpRequest('/auth/dev/login', {
		method: 'POST',
	});
}
