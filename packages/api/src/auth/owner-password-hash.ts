/** Bound both minimum strength and verification resources before Bun parses a PHC hash. */
export function isOwnerPasswordHash(value: string): boolean {
	const match = /^\$argon2id\$v=19\$m=(\d{1,5}),t=([2-4]),p=([1-4])\$([A-Za-z0-9+/]{22,43})\$([A-Za-z0-9+/]{43})$/.exec(value);
	if (!match) {
		return false;
	}
	const memory = Number(match[1]);
	if (memory < 19456 || memory > 65536) {
		return false;
	}
	const salt = match[4]!;
	const digest = match[5]!;
	const saltBytes = Buffer.from(salt, 'base64');
	return saltBytes.length >= 16 && saltBytes.length <= 32 && saltBytes.toString('base64').replace(/=+$/, '') === salt && Buffer.from(digest, 'base64').toString('base64').replace(/=+$/, '') === digest;
}
