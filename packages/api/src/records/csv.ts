import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

/**
 * Rows of values as CSV, one row a line, as a spreadsheet's ranges are read and written: a value
 * holding a comma, a quote or a line break in quotes, a quote in it doubled.
 */

function csvValue(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvOf(rows: string[][]): string {
	return rows.map((row) => row.map(csvValue).join(',')).join('\n');
}

/**
 * The rows CSV gives, a line break inside quotes kept in its value, and a line with nothing on it,
 * as a second line break at the end, no row; an unclosed quote is turned down.
 */
export function parseCsv(text: string): Result<string[][], ApiError> {
	const rows: string[][] = [];
	let row: string[] = [];
	let value = '';
	let quoted = false;
	// Whether the line read so far has anything on it, even an empty value in quotes, as `""` is.
	let started = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (!quoted && (char === '\n' || char === '\r')) {
			if (char === '\r' && text[index + 1] === '\n') {
				index += 1;
			}
			if (started) {
				rows.push([...row, value]);
			}
			row = [];
			value = '';
			started = false;
			continue;
		}
		started = true;
		if (quoted && char === '"' && text[index + 1] === '"') {
			value += '"';
			index += 1;
			continue;
		}
		if (char === '"' && (quoted || value === '')) {
			quoted = !quoted;
			continue;
		}
		if (quoted) {
			value += char;
			continue;
		}
		if (char === ',') {
			row.push(value);
			value = '';
			continue;
		}
		value += char;
	}
	if (quoted) {
		return Err(ApiErr.validationError('The CSV has a quote that is never closed'));
	}
	// The last row, unless a line break already ended it.
	if (started) {
		rows.push([...row, value]);
	}
	return Ok(rows);
}
