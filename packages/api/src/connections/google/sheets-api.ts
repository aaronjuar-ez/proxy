import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {googleRequest, googleWrite} from './google-client';

/**
 * The Sheets v4 calls the `files` and `ranges` collections make, and the reading of their answers:
 * a spreadsheet's tabs, and the values in ranges of one, read as Sheets shows them and written as
 * if typed in, so a number stays a number and `=SUM(B2:B9)` is a formula.
 */

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The last column read: ZZ, the 702nd. */
const LAST_COLUMN = 'ZZ';

const sheetSchema = z.object({
	properties: z.object({
		sheetId: z.number(),
		title: z.string(),
		// The grid's size, empty cells included. A chart's tab has none.
		gridProperties: z.object({rowCount: z.number().optional(), columnCount: z.number().optional()}).optional(),
	}),
});

const spreadsheetSchema = z.object({sheets: z.array(sheetSchema).optional()});

/** One tab of a spreadsheet and the size of its grid. */
export type Sheet = {sheetId: number; title: string; rowCount: number; columnCount: number};

// Formatted values are text; a cell left empty is an empty string, and empty cells at the end of a
// row are left out.
const cellSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const valueRangeSchema = z.object({values: z.array(z.array(cellSchema)).optional()});

const batchSchema = z.object({valueRanges: z.array(valueRangeSchema)});

/** A spreadsheet's tabs, in order. */
export async function getSheets(accessToken: string, spreadsheetId: string): Promise<Result<Sheet[], ApiError>> {
	const url = new URL(`${SHEETS}/${spreadsheetId}`);
	url.searchParams.set('fields', 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))');
	const spreadsheet = await googleRequest(accessToken, url, spreadsheetSchema);
	return spreadsheet.map(({sheets = []}) =>
		sheets.map(({properties}) => ({
			sheetId: properties.sheetId,
			title: properties.title,
			rowCount: properties.gridProperties?.rowCount ?? 0,
			columnCount: properties.gridProperties?.columnCount ?? 0,
		})),
	);
}

// A tab's title as A1 notation quotes it: `'Alex''s notes'`.
function quotedTitle(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

/** Rows `from` to `to` of a tab, every column, as A1 notation writes them: `'Q1 Sales'!A2:ZZ51`. */
export function rowsRange(title: string, from: number, to: number): string {
	return `${quotedTitle(title)}!A${from}:${LAST_COLUMN}${to}`;
}

/** One cell of a tab, its column counting from 0: `'Q1 Sales'!C5`. */
export function cellRange(title: string, column: number, row: number): string {
	return `${quotedTitle(title)}!${columnLetters(column)}${row}`;
}

// The values in a range, the range percent-encoded in the path, and what is done with them, such as `:append`.
function valuesUrl(spreadsheetId: string, range: string, params: Record<string, string> = {}, verb = ''): URL {
	const url = new URL(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}${verb}`);
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return url;
}

// What a write answers: the range it changed, and, where asked for, the values there now.
const updatedSchema = z.object({updatedRange: z.string().optional(), updatedRows: z.number().optional(), updatedData: valueRangeSchema.optional()});

const appendSchema = z.object({updates: z.object({updatedRange: z.string()})});

/** The values in a range, as Sheets shows them, and the range itself as Sheets writes it. */
export async function getValues(accessToken: string, spreadsheetId: string, range: string): Promise<Result<{range: string; values: string[][]}, ApiError>> {
	const answer = await googleRequest(accessToken, valuesUrl(spreadsheetId, range), valueRangeSchema.extend({range: z.string()}));
	return answer.map((read) => ({range: read.range, values: read.values ?? []}));
}

/** Writes values into a range, as if typed in, and answers the range written and the values there now. */
export async function putValues(accessToken: string, spreadsheetId: string, range: string, values: string[][]): Promise<Result<{range: string; values: string[][]}, ApiError>> {
	const url = valuesUrl(spreadsheetId, range, {valueInputOption: 'USER_ENTERED', includeValuesInResponse: 'true', responseValueRenderOption: 'FORMATTED_VALUE'});
	const answer = await googleWrite(accessToken, 'PUT', url, {range, majorDimension: 'ROWS', values}, updatedSchema);
	return answer.map((written) => ({range: written.updatedRange ?? range, values: written.updatedData?.values ?? []}));
}

// Where a write's answer says it wrote: the part after the last "!", since a tab's title can hold
// one too, as in `'a!B7'!A12:C12`.
const writtenSchema = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?\d+)?$/;

function writtenCells(range: string): Result<{column: number; row: number; lastColumn: number}, ApiError> {
	const [, first = '', row = '', last] = writtenSchema.exec(range.slice(range.lastIndexOf('!') + 1)) ?? [];
	return requirePresent(row || null, ApiErr.validationError(`Google answered a range that names no row: ${range}`)).map(() => ({
		column: columnIndex(first),
		row: Number(row),
		lastColumn: columnIndex(last ?? first),
	}));
}

/**
 * Adds a row under the last of a tab's rows that hold anything, as if typed in, and answers the
 * row's number. Sheets appends after the last block of rows in the range it is given, starting at
 * that block's first column, so the whole tab is given; where its last block doesn't start in
 * column A, the row is written again from A.
 */
export async function appendRow(accessToken: string, spreadsheetId: string, title: string, cells: string[]): Promise<Result<number, ApiError>> {
	const url = valuesUrl(spreadsheetId, quotedTitle(title), {valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS'}, ':append');
	return Do(async ($) => {
		const {updates} = $(await googleWrite(accessToken, 'POST', url, {majorDimension: 'ROWS', values: [cells]}, appendSchema));
		const written = $(writtenCells(updates.updatedRange));
		if (written.column === 0) {
			return written.row;
		}
		// The row's own cells from A, and the ones written past them emptied.
		const width = Math.max(cells.length, written.lastColumn + 1);
		const row = Array.from({length: width}, (_, column) => cells[column] ?? '');
		const range = `${quotedTitle(title)}!A${written.row}:${columnLetters(width - 1)}${written.row}`;
		$(await putValues(accessToken, spreadsheetId, range, [row]));
		return written.row;
	});
}

/** Writes each value into its own cell, as if typed in, the cells around them as they are. */
export async function updateCells(accessToken: string, spreadsheetId: string, cells: {range: string; value: string}[]): Promise<Result<void, ApiError>> {
	const data = cells.map(({range, value}) => ({range, majorDimension: 'ROWS', values: [[value]]}));
	const answer = await googleWrite(accessToken, 'POST', new URL(`${SHEETS}/${spreadsheetId}/values:batchUpdate`), {valueInputOption: 'USER_ENTERED', data}, z.object({}));
	return answer.map(() => undefined);
}

/** Renames a tab. */
export async function renameSheet(accessToken: string, spreadsheetId: string, sheetId: number, title: string): Promise<Result<void, ApiError>> {
	const request = {updateSheetProperties: {properties: {sheetId, title}, fields: 'title'}};
	const answer = await googleWrite(accessToken, 'POST', new URL(`${SHEETS}/${spreadsheetId}:batchUpdate`), {requests: [request]}, z.object({}));
	return answer.map(() => undefined);
}

/** The values in each range, in the order asked, one list of cells a row. */
export async function getRanges(accessToken: string, spreadsheetId: string, ranges: string[]): Promise<Result<string[][][], ApiError>> {
	const url = new URL(`${SHEETS}/${spreadsheetId}/values:batchGet`);
	for (const range of ranges) {
		url.searchParams.append('ranges', range);
	}
	const batch = await googleRequest(accessToken, url, batchSchema);
	return batch.map(({valueRanges}) => valueRanges.map((range) => range.values ?? []));
}

/** A column's position counting from 0, from its letters: 0 for A, 26 for AA. */
export function columnIndex(letters: string): number {
	return [...letters].reduce((index, letter) => index * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
}

/** A column's letters, from its position counting from 0: A, Z, AA. */
export function columnLetters(index: number): string {
	const letter = String.fromCharCode(65 + (index % 26));
	return index < 26 ? letter : `${columnLetters(Math.floor(index / 26) - 1)}${letter}`;
}
