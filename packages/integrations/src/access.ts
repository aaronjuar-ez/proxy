import type {Collection, Condition, Integration} from './types';

// Access is set per action of a connection, in two layers: the connection's default, and an
// agent's own setting where it differs from the default. What can be set at all is what the
// catalog lists, which is what Personal Agent Proxy can do with the provider.

// An agent's own settings for a connection, by action; an action left out follows the default.
export type OwnSettings = Partial<Record<string, boolean>>;

/**
 * What an agent can do with a connection: its own setting for each action, else the default as it
 * is now, leaving out an action whose required one is off, as Archive is without Read, or counts
 * for nothing itself, as Invite guests does once Read events is off under Create and edit events,
 * and the `unavailable` ones the connection's sign-in didn't cover, whatever is ticked.
 */
export function effectiveActions(
	integration: Integration,
	defaults: string[],
	own: OwnSettings = {},
	unavailable: string[] = [],
): string[] {
	const chosen = (id: string) => !unavailable.includes(id) && (own[id] ?? defaults.includes(id));
	const counts = (id: string, seen: string[]): boolean => {
		const action = integration.actions.find((candidate) => candidate.id === id);
		if (!action || !chosen(id) || seen.includes(id)) {
			return false;
		}
		return !action.requires || counts(action.requires, [...seen, id]);
	};
	return integration.actions.filter((action) => counts(action.id, [])).map((action) => action.id);
}

/**
 * The action a request needs: the collection's read to list or view, its own for a write or a
 * command. Null when the collection doesn't offer it at all.
 */
export function requiredAction(collection: Collection, request: string): string | null {
	if (request === 'list' || request === 'view') {
		return collection.read ?? null;
	}

	if (request === 'create' || request === 'update' || request === 'delete') {
		return collection.writes[request] ?? null;
	}

	return collection.commands?.find((command) => command.id === request)?.action ?? null;
}

/** Whether a record is one a condition picks out; true without a condition. */
export function applies(condition: Condition | undefined, values: Record<string, string>): boolean {
	if (!condition) {
		return true;
	}
	return condition.values.includes(values[condition.field] ?? '');
}
