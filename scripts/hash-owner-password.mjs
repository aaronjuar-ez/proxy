#!/usr/bin/env bun

// Run locally in a private terminal. Never accepts a password in argv or an environment variable.
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';

if (!process.stdin.isTTY || !process.stderr.isTTY || process.argv.length !== 2) {
	console.error(
		'Run bun scripts/hash-owner-password.mjs in an interactive terminal, without arguments.',
	);
	process.exit(1);
}

const hiddenOutput = new Writable({
	write(_chunk, _encoding, done) {
		done();
	},
});
const input = createInterface({input: process.stdin, output: hiddenOutput, terminal: true});
input.on('SIGINT', () => {
	input.close();
	process.stderr.write('\nCancelled.\n');
	process.exit(130);
});

function ask(label) {
	process.stderr.write(label);
	return new Promise((resolve) =>
		input.question('', (answer) => {
			process.stderr.write('\n');
			resolve(answer);
		}),
	);
}

let first = await ask('New owner password (hidden, at least 15 characters): ');
let second = await ask('Repeat password (hidden): ');
input.close();
if (first !== second || [...first].length < 15 || Buffer.byteLength(first, 'utf8') > 1024) {
	console.error('Passwords must match and contain 15 or more characters, up to 1024 UTF-8 bytes.');
	process.exit(1);
}
const hash = await Bun.password.hash(first, {
	algorithm: 'argon2id',
	memoryCost: 65536,
	timeCost: 3,
});
first = '';
second = '';
process.stderr.write(
	'Store this hash as the secret OWNER_PASSWORD_HASH. Do not share it or commit it.\n',
);
process.stdout.write(`${hash}\n`);
