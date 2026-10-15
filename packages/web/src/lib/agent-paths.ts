// What the address of a list inside `parent` adds, in a nested collection: `?parent=…`.
export function inside(parent: string | null): string {
	return parent ? `?parent=${encodeURIComponent(parent)}` : '';
}

// A record's place in a list's address, its id encoded: a calendar's can hold `#`.
export function recordPath(listPath: string, recordId: string): string {
	return `${listPath}/${encodeURIComponent(recordId)}`;
}
