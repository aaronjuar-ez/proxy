// Only same-site paths: `/foo` is fine; `//evil.com`, `https://evil.com`, `javascript:` and
// backslash variants (`/\evil.com`) that some browsers normalize to `//` are not.
export function sanitizeCallbackUrl(raw: string | null): string | undefined {
	if (!raw) {
		return undefined;
	}
	// Browsers strip tabs and newlines from URLs before resolving their host.
	if (
		!raw.startsWith('/') ||
		Array.from(raw).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
	) {
		return undefined;
	}
	if (raw.startsWith('//') || raw.startsWith('/\\')) {
		return undefined;
	}
	return raw;
}
