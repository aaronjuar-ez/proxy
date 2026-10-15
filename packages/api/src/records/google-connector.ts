import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {Connector, RecordTarget} from './connector';
import {gmailConnector} from './google-emails';
import {getFilesRecord, listFilesTree} from './google-files';

/**
 * A Google account, fetched live from Google's APIs with the connection's tokens, one collection
 * per product: `emails`, Gmail (`google-emails.ts`), and `files`, Drive with Docs, Sheets and
 * Slides (`google-files.ts`). Files aren't written yet: that collection offers no writes, and the
 * connector turns any down.
 */

function notWritten(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Files in Google Drive can’t be changed here yet')));
}

const filesConnector: Connector = {
	list: listFilesTree,
	get: getFilesRecord,
	create: notWritten,
	update: notWritten,
	remove: notWritten,
};

const COLLECTIONS: Partial<Record<string, Connector>> = {emails: gmailConnector, files: filesConnector};

function unknownCollection(target: RecordTarget): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.notFound('collection', target.collection.id)));
}

const unknownConnector: Connector = {list: unknownCollection, get: unknownCollection, create: unknownCollection, update: unknownCollection, remove: unknownCollection};

function connectorOf(target: RecordTarget): Connector {
	return COLLECTIONS[target.collection.id] ?? unknownConnector;
}

export const googleConnector: Connector = {
	list: (target, query) => connectorOf(target).list(target, query),
	get: (target, recordId) => connectorOf(target).get(target, recordId),
	create: (target, values, parent) => connectorOf(target).create(target, values, parent),
	update: (target, recordId, values) => connectorOf(target).update(target, recordId, values),
	remove: (target, recordId) => connectorOf(target).remove(target, recordId),
	// Only email has commands.
	commands: gmailConnector.commands,
	newCommands: gmailConnector.newCommands,
};
