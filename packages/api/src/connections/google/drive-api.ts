import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleText} from './google-client';

/**
 * The Drive v3 calls the `files` collection makes, and the reading of their answers. Every call
 * takes shared drives too.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';

export const PAGE_SIZE = 50;

/** Drive's ids, as every id an agent sends is checked against before it reaches an address or a query. */
export const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

export const MIME_TYPES = {
	folder: 'application/vnd.google-apps.folder',
	document: 'application/vnd.google-apps.document',
	spreadsheet: 'application/vnd.google-apps.spreadsheet',
	presentation: 'application/vnd.google-apps.presentation',
};

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,parents,driveId';

const driveFileSchema = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	modifiedTime: z.string().optional(),
	// None in a shared drive, which owns its files.
	owners: z.array(z.object({displayName: z.string().optional(), emailAddress: z.string().optional()})).optional(),
	webViewLink: z.string().optional(),
	parents: z.array(z.string()).optional(),
	driveId: z.string().optional(),
});

export type DriveFile = z.infer<typeof driveFileSchema>;

const fileListSchema = z.object({files: z.array(driveFileSchema), nextPageToken: z.string().optional()});

/** A file's place in the tree: its name, the folder it is in, and the shared drive it is in. */
const fileParentsSchema = z.object({id: z.string(), name: z.string(), parents: z.array(z.string()).optional(), driveId: z.string().optional()});

export type FileParents = z.infer<typeof fileParentsSchema>;

const sharedDriveSchema = z.object({id: z.string(), name: z.string()});

export type SharedDrive = z.infer<typeof sharedDriveSchema>;

const driveListSchema = z.object({drives: z.array(sharedDriveSchema), nextPageToken: z.string().optional()});

export type Page<T> = {items: T[]; nextPage: string | null};

function driveUrl(path: string, params: Record<string, string>): URL {
	const url = new URL(`${DRIVE}${path}`);
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return url;
}

/** A term in Drive's query language, quoted: a backslash and a quote escaped with a backslash. */
export function driveQuoted(term: string): string {
	return `'${term.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * One page of files matching `q`, from the page a previous one pointed at. `params` narrows the
 * list further, such as to one shared drive (`corpora`, `driveId`) or by an order (`orderBy`).
 */
export async function listFiles(accessToken: string, q: string, params: Record<string, string>, pageToken: string | null): Promise<Result<Page<DriveFile>, ApiError>> {
	const url = driveUrl('/files', {
		q,
		pageSize: String(PAGE_SIZE),
		fields: `nextPageToken,files(${FILE_FIELDS})`,
		supportsAllDrives: 'true',
		includeItemsFromAllDrives: 'true',
		...params,
		...(pageToken ? {pageToken} : {}),
	});
	const list = await googleRequest(accessToken, url, fileListSchema);
	return list.map(({files, nextPageToken}) => ({items: files, nextPage: nextPageToken ?? null}));
}

/** A file's metadata. */
export function getFile(accessToken: string, fileId: string): Promise<Result<DriveFile, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/files/${fileId}`, {fields: FILE_FIELDS, supportsAllDrives: 'true'}), driveFileSchema);
}

/** Where a file is: only what walking up the tree needs. */
export function getFileParents(accessToken: string, fileId: string): Promise<Result<FileParents, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/files/${fileId}`, {fields: 'id,name,parents,driveId', supportsAllDrives: 'true'}), fileParentsSchema);
}

/** The id of My Drive itself, which Drive calls `root` in queries but names by its own id in `parents`. */
export async function getMyDriveId(accessToken: string): Promise<Result<string, ApiError>> {
	const root = await googleRequest(accessToken, driveUrl('/files/root', {fields: 'id'}), z.object({id: z.string()}));
	return root.map(({id}) => id);
}

/** A Google document, spreadsheet or presentation exported as text, such as `text/markdown`. */
export function exportFile(accessToken: string, fileId: string, mimeType: string): Promise<Result<string, ApiError>> {
	return googleText(accessToken, driveUrl(`/files/${fileId}/export`, {mimeType}));
}

/** One page of the shared drives the account is a member of, those whose names contain `search` when given. */
export async function listSharedDrives(accessToken: string, search: string | null, pageToken: string | null): Promise<Result<Page<SharedDrive>, ApiError>> {
	const url = driveUrl('/drives', {pageSize: String(PAGE_SIZE), ...(search ? {q: `name contains ${driveQuoted(search)}`} : {}), ...(pageToken ? {pageToken} : {})});
	const list = await googleRequest(accessToken, url, driveListSchema);
	return list.map(({drives, nextPageToken}) => ({items: drives, nextPage: nextPageToken ?? null}));
}

export function getSharedDrive(accessToken: string, driveId: string): Promise<Result<SharedDrive, ApiError>> {
	return googleRequest(accessToken, driveUrl(`/drives/${driveId}`, {fields: 'id,name'}), sharedDriveSchema);
}
