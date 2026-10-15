import {findIntegration} from '@proxy/integrations';

import type {GoogleCredential} from './google-oauth';

/**
 * Which of Google's scopes allow each action. Google's consent screen lets a person untick some of
 * what a sign-in asks for, and a connection made before an action joined the catalog lacks its
 * scope, so an action is only available where the sign-in granted one of the scopes allowing it.
 */

const scope = (name: string): string => `https://www.googleapis.com/auth/${name}`;

// Any one of an action's scopes is enough. Drive's export and the Docs and Sheets APIs all take
// `drive`, so it alone covers reading files.
const ACTION_SCOPES: Partial<Record<string, string[]>> = {
	readFiles: [scope('drive')],
};

/** The actions a Google sign-in didn't cover, in the catalog's order; one the map leaves out is never covered. */
export function unavailableGoogleActions(credential: GoogleCredential): string[] {
	const actions = findIntegration('google')?.actions ?? [];
	return actions.filter((action) => !(ACTION_SCOPES[action.id] ?? []).some((allowing) => credential.scopes.includes(allowing))).map((action) => action.id);
}
