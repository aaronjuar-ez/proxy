import {findIntegration} from '@proxy/integrations';

import type {GoogleCredential} from './google-oauth';

/**
 * Which of Google's scopes allow each action. Google's consent screen lets a person untick some of
 * what a sign-in asks for, and a connection made before an action joined the catalog lacks its
 * scope, so an action is only available where the sign-in granted one of the scopes allowing it.
 */

const scope = (name: string): string => `https://www.googleapis.com/auth/${name}`;

// Gmail's reading, labelling, Trash and drafts all take `gmail.modify`; sending takes it too, or
// `gmail.send` alone.
const GMAIL = [scope('gmail.modify')];

// Any one of an action's scopes is enough. Drive's export and uploads and the Sheets API take
// `drive` for reading and writing alike, so it alone covers every file action.
const DRIVE = [scope('drive')];

const ACTION_SCOPES: Partial<Record<string, string[]>> = {
	readEmails: GMAIL,
	markEmails: GMAIL,
	flagEmails: GMAIL,
	archiveEmails: GMAIL,
	writeEmails: GMAIL,
	trashEmails: GMAIL,
	sendEmails: [scope('gmail.send'), scope('gmail.modify')],
	readFiles: DRIVE,
	createFiles: DRIVE,
	editFiles: DRIVE,
	trashFiles: DRIVE,
};

/** The actions a Google sign-in didn't cover, in the catalog's order; one the map leaves out is never covered. */
export function unavailableGoogleActions(credential: GoogleCredential): string[] {
	const actions = findIntegration('google')?.actions ?? [];
	return actions.filter((action) => !(ACTION_SCOPES[action.id] ?? []).some((allowing) => credential.scopes.includes(allowing))).map((action) => action.id);
}
