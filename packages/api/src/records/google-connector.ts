import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import type {Connector, RecordTarget} from './connector';
import {getFilesRecord, listFilesTree} from './google-files';

/**
 * A Google account, fetched live from Google's APIs with the connection's tokens, one collection
 * per product: `files`, Drive with Docs, Sheets and Slides (`google-files.ts`). Nothing is written
 * yet: the collections offer no writes, and the connector turns any down.
 */

function unknownCollection(target: RecordTarget): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.notFound('collection', target.collection.id)));
}

function notWritten(): Promise<Result<never, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Files in Google Drive can’t be changed here yet')));
}

export const googleConnector: Connector = {
	list: (target, query) => (target.collection.id === 'files' ? listFilesTree(target, query) : unknownCollection(target)),
	get: (target, recordId) => (target.collection.id === 'files' ? getFilesRecord(target, recordId) : unknownCollection(target)),
	create: notWritten,
	update: notWritten,
	remove: notWritten,
};
