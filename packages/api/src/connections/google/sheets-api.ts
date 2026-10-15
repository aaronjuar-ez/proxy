import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest} from './google-client';

/**
 * The Sheets v4 calls the `files` collection makes, and the reading of their answers: a
 * spreadsheet's tabs, and the values in ranges of one.
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

/** Rows `from` to `to` of a tab, every column, as A1 notation writes them: `'Q1 Sales'!A2:ZZ51`. */
export function rowsRange(title: string, from: number, to: number): string {
	return `'${title.replace(/'/g, "''")}'!A${from}:${LAST_COLUMN}${to}`;
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

/** A column's letters, from its position counting from 0: A, Z, AA. */
export function columnLetters(index: number): string {
	const letter = String.fromCharCode(65 + (index % 26));
	return index < 26 ? letter : `${columnLetters(Math.floor(index / 26) - 1)}${letter}`;
}
