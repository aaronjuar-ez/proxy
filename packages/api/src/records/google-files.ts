import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {
	DRIVE_ID,
	driveQuoted,
	exportFile,
	getFile,
	getFileParents,
	getMyDriveId,
	getSharedDrive,
	listFiles,
	listSharedDrives,
	MIME_TYPES,
	PAGE_SIZE,
	type DriveFile,
	type FileParents,
	type SharedDrive,
} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {columnLetters, getRanges, getSheets, rowsRange, type Sheet} from '../connections/google/sheets-api';
import type {Crumb, DataRecord, ListQuery, RecordPage, RecordTarget} from './connector';
import {valueLines} from './value-lines';

/**
 * A Google account's Drive as the `files` collection: a tree, fetched live. At the top are four
 * places, My Drive, Shared with me, Shared drives and Recent; inside them, and inside folders and
 * shared drives, are files, folders first, 50 to a page with Drive's own page token. A search is
 * Drive's, in names and contents, anywhere or inside the folder or place opened.
 *
 * A document opens as Markdown and a presentation as text, as Drive exports them, up to Drive's
 * 10 MB; a spreadsheet opens into its tabs, and a tab into its rows, 50 to a page, each row's values
 * as "Header: value" lines, the headers from the tab's first row. Other files open as what Drive
 * knows of them, with a link. Nothing is written yet.
 */

const PLACES = [
	{id: 'root', name: 'My Drive'},
	{id: 'shared-with-me', name: 'Shared with me'},
	{id: 'shared-drives', name: 'Shared drives'},
	{id: 'recent', name: 'Recent'},
] as const;

type Place = (typeof PLACES)[number];

const [MY_DRIVE, SHARED_WITH_ME, SHARED_DRIVES] = PLACES;

// Folders first, then the last changed, as Drive shows a folder.
const FOLDER_ORDER = 'folder,modifiedTime desc';

// How far up the folders a trail goes before it stops looking.
const MAX_DEPTH = 10;

// Rows looked through past a page of rows that came back short, for the next one holding anything.
const LOOKAHEAD_ROWS = 1000;

/**
 * What a record id names: a place, a shared drive (`drive-<id>`), a Drive file by its own id, a
 * spreadsheet's tab (`sheet-<file>-<tab>`), or a row of one (`row-<file>-<tab>-<row>`, its number
 * in the tab, from 2 since row 1 holds the headers).
 */
type FileRef =
	| {kind: 'place'; place: Place}
	| {kind: 'drive'; driveId: string}
	| {kind: 'file'; fileId: string}
	| {kind: 'sheet'; fileId: string; sheetId: number}
	| {kind: 'row'; fileId: string; sheetId: number; row: number};

function parseRef(recordId: string): FileRef | null {
	const place = PLACES.find((candidate) => candidate.id === recordId);
	if (place) {
		return {kind: 'place', place};
	}
	const drive = /^drive-([A-Za-z0-9_-]+)$/.exec(recordId);
	if (drive?.[1]) {
		return {kind: 'drive', driveId: drive[1]};
	}
	const sheet = /^sheet-([A-Za-z0-9_-]+)-(\d{1,12})$/.exec(recordId);
	if (sheet?.[1] && sheet[2]) {
		return {kind: 'sheet', fileId: sheet[1], sheetId: Number(sheet[2])};
	}
	const row = /^row-([A-Za-z0-9_-]+)-(\d{1,12})-(\d{1,7})$/.exec(recordId);
	if (row?.[1] && row[2] && row[3] && Number(row[3]) >= 2) {
		return {kind: 'row', fileId: row[1], sheetId: Number(row[2]), row: Number(row[3])};
	}
	if (DRIVE_ID.test(recordId)) {
		return {kind: 'file', fileId: recordId};
	}
	return null;
}

function requireRef(recordId: string): Result<FileRef, ApiError> {
	const ref = parseRef(recordId);
	if (!ref) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(ref);
}

function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

/** One request's way into Drive: the access token, and My Drive's own id, asked for once at most. */
type Drive = {token: string; myDriveId: () => Promise<Result<string, ApiError>>};

function withDrive<T>(target: RecordTarget, run: (drive: Drive) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callGoogle(target.connection, (token) => {
		let myDriveId: Promise<Result<string, ApiError>> | null = null;
		return run({token, myDriveId: () => (myDriveId ??= getMyDriveId(token))});
	});
}

function kindOf(mimeType: string): string {
	if (mimeType === MIME_TYPES.folder) {
		return 'Folder';
	}
	if (mimeType === MIME_TYPES.document) {
		return 'Document';
	}
	if (mimeType === MIME_TYPES.spreadsheet) {
		return 'Spreadsheet';
	}
	if (mimeType === MIME_TYPES.presentation) {
		return 'Presentation';
	}
	// Shortcuts too: they open as themselves, not as what they point at.
	return 'File';
}

function fileValues(file: DriveFile): Record<string, string> {
	const owner = file.owners?.[0];
	return {name: file.name, kind: kindOf(file.mimeType), modified: file.modifiedTime ?? '', owner: owner?.displayName ?? owner?.emailAddress ?? '', link: file.webViewLink ?? ''};
}

function fileRecord(file: DriveFile): DataRecord {
	const kind = kindOf(file.mimeType);
	return {id: file.id, values: fileValues(file), updatedAt: file.modifiedTime ?? '', ...(kind === 'Folder' || kind === 'Spreadsheet' ? {hasChildren: true} : {})};
}

function placeRecord(place: Place): DataRecord {
	return {id: place.id, values: {name: place.name, kind: 'Place'}, updatedAt: '', hasChildren: true};
}

function driveRecord(drive: SharedDrive): DataRecord {
	return {id: `drive-${drive.id}`, values: {name: drive.name, kind: 'Folder'}, updatedAt: '', hasChildren: true};
}

function sheetId(file: DriveFile, sheet: Sheet): string {
	return `sheet-${file.id}-${sheet.sheetId}`;
}

function sheetLink(file: DriveFile, sheet: Sheet): string {
	return file.webViewLink ? `${file.webViewLink}#gid=${sheet.sheetId}` : '';
}

// "Sheet1: 120 rows, 8 columns", the tab's grid, empty cells included.
function sheetSize(sheet: Sheet): string {
	return `${sheet.rowCount} rows, ${sheet.columnCount} columns`;
}

function sheetRecord(file: DriveFile, sheet: Sheet): DataRecord {
	return {
		id: sheetId(file, sheet),
		values: {...fileValues(file), name: sheet.title, kind: 'Sheet', link: sheetLink(file, sheet), content: sheetSize(sheet)},
		updatedAt: file.modifiedTime ?? '',
		hasChildren: true,
	};
}

// A row's values under the tab's headers; a column without one goes by its letter.
function rowRecord(file: DriveFile, sheet: Sheet, headers: string[], row: number, cells: string[]): DataRecord {
	const content = valueLines(cells.map((cell, column): [string, string] => [headers[column] || `Column ${columnLetters(column)}`, cell]));
	return {
		id: `row-${file.id}-${sheet.sheetId}-${row}`,
		// Rows have no time of their own; the spreadsheet's is when anything in it changed.
		values: {...fileValues(file), name: cells[0] || `Row ${row}`, kind: 'Row', link: sheetLink(file, sheet), content},
		updatedAt: file.modifiedTime ?? '',
	};
}

function isBlank(cells: string[]): boolean {
	return cells.every((cell) => cell === '');
}

/** A spreadsheet and its tab, the tab found by its id among the spreadsheet's. */
function getSheet(drive: Drive, fileId: string, id: number): Promise<Result<{file: DriveFile; sheet: Sheet}, ApiError>> {
	return Do(async ($) => {
		const [file, sheets] = await Promise.all([getFile(drive.token, fileId), getSheets(drive.token, fileId)]);
		const sheet = $(sheets).find((candidate) => candidate.sheetId === id);
		if (!sheet) {
			return $(Err(ApiErr.notFound('sheet')));
		}
		return {file: $(file), sheet};
	});
}

/**
 * The records above a file, from the top: where it is, then its folders, the nearest last. Drive
 * gives each file the folder it is in; walking up stops at My Drive, at the top of a shared drive
 * (whose folder has the drive's own id), or where the account can't see further up, as with a
 * folder someone shared, or a shared drive it isn't a member of, which is then under Shared with me. Past 10 folders it stops looking, and
 * the trail starts at the 10th.
 */
function crumbsAbove(drive: Drive, file: FileParents): Promise<Result<Crumb[], ApiError>> {
	return Do(async ($) => {
		const sharedDriveId = file.driveId;
		const myDriveId = sharedDriveId ? null : $(await drive.myDriveId());
		const folders: Crumb[] = [];
		let parentId = file.parents?.[0];
		for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
			if (parentId === undefined) {
				return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
			}
			if (parentId === myDriveId) {
				return [{id: MY_DRIVE.id, title: MY_DRIVE.name}, ...folders];
			}
			if (parentId === sharedDriveId) {
				// A shared drive the account isn't a member of, which someone shared a file from.
				const shared = await getSharedDrive(drive.token, sharedDriveId);
				if (shared.isErr() && shared.error.kind === 'not_found') {
					return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
				}
				const {id, name} = $(shared);
				return [{id: SHARED_DRIVES.id, title: SHARED_DRIVES.name}, {id: `drive-${id}`, title: name}, ...folders];
			}
			const parent = await getFileParents(drive.token, parentId);
			if (parent.isErr() && parent.error.kind === 'not_found') {
				return [{id: SHARED_WITH_ME.id, title: SHARED_WITH_ME.name}, ...folders];
			}
			const {id, name, parents} = $(parent);
			folders.unshift({id, title: name});
			parentId = parents?.[0];
		}
		return folders;
	});
}

/** The trail to a file: the records above it, then the file. */
function trailTo(drive: Drive, file: DriveFile): Promise<Result<Crumb[], ApiError>> {
	return Do(async ($) => [...$(await crumbsAbove(drive, file)), {id: file.id, title: file.name}]);
}

/**
 * One page of files matching `terms`, in `order`, or, searched, in the order Drive finds best,
 * since Drive sorts no full-text search. Trashed files are never listed.
 */
function filesPage(drive: Drive, query: ListQuery, args: {terms: string[]; order: string | null; params?: Record<string, string>}): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const search = query.search === null ? [] : [`fullText contains ${driveQuoted(query.search)}`];
		const q = [...search, ...args.terms, 'trashed=false'].join(' and ');
		const order: Record<string, string> = query.search === null && args.order ? {orderBy: args.order} : {};
		const page = $(await listFiles(drive.token, q, {...order, ...args.params}, query.page));
		return {records: page.items.map(fileRecord), nextPage: page.nextPage};
	});
}

function inParents(id: string): string {
	return `${driveQuoted(id)} in parents`;
}

function listPlace(drive: Drive, place: Place, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const trail = [{id: place.id, title: place.name}];
		if (place.id === 'root') {
			return {...$(await filesPage(drive, query, {terms: [inParents('root')], order: FOLDER_ORDER})), trail};
		}
		if (place.id === 'shared-with-me') {
			return {...$(await filesPage(drive, query, {terms: ['sharedWithMe=true'], order: 'sharedWithMeTime desc'})), trail};
		}
		if (place.id === 'recent') {
			// As Drive's own Recent: files the account opened, last first, shared drives' too.
			const terms = ["viewedByMeTime > '1970-01-01T00:00:00'", `mimeType != '${MIME_TYPES.folder}'`];
			return {...$(await filesPage(drive, query, {terms, order: 'viewedByMeTime desc', params: {corpora: 'allDrives'}})), trail};
		}
		// Shared drives are searched by their names.
		const drives = $(await listSharedDrives(drive.token, query.search, query.page));
		return {records: drives.items.map(driveRecord), nextPage: drives.nextPage, trail};
	});
}

function listSharedDrive(drive: Drive, driveId: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const [shared, page] = await Promise.all([getSharedDrive(drive.token, driveId), filesPage(drive, query, {terms: [inParents(driveId)], order: FOLDER_ORDER, params: {corpora: 'drive', driveId}})]);
		const {id, name} = $(shared);
		return {
			...$(page),
			trail: [
				{id: SHARED_DRIVES.id, title: SHARED_DRIVES.name},
				{id: `drive-${id}`, title: name},
			],
		};
	});
}

/** A tab's rows, 50 to a page, the page token the number of the row it starts at. */
function listRows(drive: Drive, ref: {fileId: string; sheetId: number}, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		if (query.page !== null && !/^\d{1,7}$/.test(query.page)) {
			return $(Err(ApiErr.validationError(`Not a page of rows: ${query.page}`)));
		}
		const from = Math.max(Number(query.page ?? 2), 2);
		const to = from + PAGE_SIZE - 1;
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		const tab = {id: sheetId(file, sheet), title: sheet.title};
		// Sheets refuses a range wholly outside the grid, so a page past the tab's last row is empty without asking.
		if (from > sheet.rowCount) {
			return {records: [], nextPage: null, trail: [...$(await trailTo(drive, file)), tab]};
		}
		const [ranges, trail] = await Promise.all([getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1), rowsRange(sheet.title, from, to)]), trailTo(drive, file)]);
		const [[headers = []] = [], rows = []] = $(ranges);
		const records = rows.flatMap((cells, index) => (isBlank(cells) ? [] : [rowRecord(file, sheet, headers, from + index, cells)]));
		const nextPage = $(await nextRowsPage(drive, file.id, sheet, to, rows.length));
		return {records, nextPage, trail: [...$(trail), tab]};
	});
}

/**
 * Where the page after rows up to `to` starts. Sheets leaves out the empty rows at the end of each
 * range asked for, so a page short of 50 may only have ended in empty rows: the rows after it are
 * looked through for the next that isn't, 1000 at a time.
 */
function nextRowsPage(drive: Drive, fileId: string, sheet: Sheet, to: number, read: number): Promise<Result<string | null, ApiError>> {
	return Do(async ($) => {
		if (to >= sheet.rowCount) {
			return null;
		}
		if (read === PAGE_SIZE) {
			return String(to + 1);
		}
		const end = Math.min(sheet.rowCount, to + LOOKAHEAD_ROWS);
		const [after = []] = $(await getRanges(drive.token, fileId, [rowsRange(sheet.title, to + 1, end)]));
		const next = after.findIndex((cells) => !isBlank(cells));
		if (next !== -1) {
			return String(to + 1 + next);
		}
		return end < sheet.rowCount ? String(end + 1) : null;
	});
}

const NOT_SEARCHED = 'Only Drive, its folders and shared drives are searched, not a spreadsheet’s tabs or rows';

// What a list opened in a file shows: a folder's files, a spreadsheet's tabs; other files hold nothing.
function listFile(drive: Drive, fileId: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const file = $(await getFile(drive.token, fileId));
		const kind = kindOf(file.mimeType);
		if (kind === 'Spreadsheet' && query.search !== null) {
			return $(Err(ApiErr.validationError(NOT_SEARCHED)));
		}
		const trail = $(await trailTo(drive, file));
		if (kind === 'Folder') {
			const params: Record<string, string> = file.driveId ? {corpora: 'drive', driveId: file.driveId} : {};
			return {...$(await filesPage(drive, query, {terms: [inParents(file.id)], order: FOLDER_ORDER, params})), trail};
		}
		if (kind === 'Spreadsheet') {
			const sheets = $(await getSheets(drive.token, file.id));
			return {records: sheets.map((sheet) => sheetRecord(file, sheet)), nextPage: null, trail};
		}
		return {records: [], nextPage: null, trail};
	});
}

function listInside(drive: Drive, ref: FileRef, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	if (ref.kind === 'place') {
		return listPlace(drive, ref.place, query);
	}
	if (ref.kind === 'drive') {
		return listSharedDrive(drive, ref.driveId, query);
	}
	if (ref.kind === 'file') {
		return listFile(drive, ref.fileId, query);
	}
	if (query.search !== null) {
		return Promise.resolve(Err(ApiErr.validationError(NOT_SEARCHED)));
	}
	if (ref.kind === 'sheet') {
		return listRows(drive, ref, query);
	}
	// A row holds nothing.
	return Do(async ($) => {
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		const trail = [...$(await trailTo(drive, file)), {id: sheetId(file, sheet), title: sheet.title}, {id: `row-${file.id}-${sheet.sheetId}-${ref.row}`, title: `Row ${ref.row}`}];
		return {records: [], nextPage: null, trail};
	});
}

export function listFilesTree(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			if (query.parent !== null) {
				const ref = $(requireRef(query.parent));
				return $((await listInside(drive, ref, query)).mapErr(notFoundAs(query.parent)));
			}
			if (query.search !== null) {
				return $(await filesPage(drive, query, {terms: [], order: null, params: {corpora: 'allDrives'}}));
			}
			return {records: PLACES.map(placeRecord), nextPage: null};
		}),
	);
}

// A document as Markdown, a presentation as text, a spreadsheet's tabs one a line; other files have none.
function contentOf(drive: Drive, file: DriveFile): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const kind = kindOf(file.mimeType);
		if (kind === 'Document') {
			return $(await exportFile(drive.token, file.id, 'text/markdown'));
		}
		if (kind === 'Presentation') {
			return $(await exportFile(drive.token, file.id, 'text/plain'));
		}
		if (kind === 'Spreadsheet') {
			const sheets = $(await getSheets(drive.token, file.id));
			return sheets.map((sheet) => `${sheet.title}: ${sheetSize(sheet)}`).join('\n');
		}
		return '';
	});
}

function getRef(drive: Drive, ref: FileRef): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		if (ref.kind === 'place') {
			return placeRecord(ref.place);
		}
		if (ref.kind === 'drive') {
			return driveRecord($(await getSharedDrive(drive.token, ref.driveId)));
		}
		if (ref.kind === 'file') {
			const file = $(await getFile(drive.token, ref.fileId));
			const record = fileRecord(file);
			return {...record, values: {...record.values, content: $(await contentOf(drive, file))}};
		}
		const {file, sheet} = $(await getSheet(drive, ref.fileId, ref.sheetId));
		if (ref.kind === 'sheet') {
			return sheetRecord(file, sheet);
		}
		// A row past the tab's last is not there, and Sheets refuses a range outside the grid rather than answering it empty.
		if (ref.row > sheet.rowCount) {
			return $(Err(ApiErr.notFound('row')));
		}
		const [[headers = []] = [], [cells = []] = []] = $(await getRanges(drive.token, file.id, [rowsRange(sheet.title, 1, 1), rowsRange(sheet.title, ref.row, ref.row)]));
		if (isBlank(cells)) {
			return $(Err(ApiErr.notFound('row')));
		}
		return rowRecord(file, sheet, headers, ref.row, cells);
	});
}

export function getFilesRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return withDrive(target, (drive) =>
		Do(async ($) => {
			const ref = $(requireRef(recordId));
			return $((await getRef(drive, ref)).mapErr(notFoundAs(recordId)));
		}),
	);
}
