import {expect, test} from 'bun:test';

import {csvOf, parseCsv} from './csv';

test('values with commas, quotes and line breaks are quoted, and read back as they were', () => {
	const rows = [
		['Item', 'Note'],
		['Rent', 'Paid, on time'],
		['Say "hi"', 'Two\nlines'],
		['', ''],
	];
	const text = csvOf(rows);

	expect(text).toBe('Item,Note\nRent,"Paid, on time"\n"Say ""hi""","Two\nlines"\n,');
	expect(parseCsv(text).unwrap()).toEqual(rows);
});

test('Windows line breaks and a line break at the end end rows, and an empty text is no rows', () => {
	expect(parseCsv('a,b\r\nc,d\r\n').unwrap()).toEqual([
		['a', 'b'],
		['c', 'd'],
	]);
	expect(parseCsv('').unwrap()).toEqual([]);
});

test('a line with nothing on it is no row, so it empties nothing', () => {
	expect(parseCsv('a\n\nb\n\n').unwrap()).toEqual([['a'], ['b']]);
	expect(parseCsv('a,b\r\n\r\nc,d').unwrap()).toEqual([
		['a', 'b'],
		['c', 'd'],
	]);
	expect(parseCsv('\n').unwrap()).toEqual([]);
	expect(parseCsv('a,\n').unwrap()).toEqual([['a', '']]);
});

test('an empty value in quotes is a row of its own, so one cell can be emptied', () => {
	expect(parseCsv('""').unwrap()).toEqual([['']]);
	expect(parseCsv('a\n""\n').unwrap()).toEqual([['a'], ['']]);
});

test('a quote inside an unquoted value is kept, and one never closed is turned down', () => {
	expect(parseCsv('5" pipe,2').unwrap()).toEqual([['5" pipe', '2']]);
	expect(parseCsv('"open,2').isErr()).toBe(true);
});
