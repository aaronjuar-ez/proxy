import {createHash} from 'node:crypto';

import {env} from '../utils/env';

/** A configuration epoch in the opaque session token invalidates sessions on credential rotation. */
export function ownerSessionPrefix(): string {
	return `owner.${createHash('sha256')
		.update(JSON.stringify([env.OWNER_USERNAME, env.OWNER_PASSWORD_HASH]))
		.digest('hex')}.`;
}
