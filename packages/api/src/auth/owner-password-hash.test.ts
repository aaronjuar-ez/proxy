import {expect, test} from 'bun:test';
import {isOwnerPasswordHash} from './owner-password-hash';
import {envSchema} from '../utils/env-schema';
const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
const digest = Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '');
const hash = `$argon2id$v=19$m=65536,t=3,p=1$${salt}$${digest}`;
test('bounded canonical Argon2id PHC accepted, weak and excessive parameters rejected', () => {
	expect(isOwnerPasswordHash(hash)).toBe(true);
	for (const invalid of [
		hash.replace('65536', '65537'),
		hash.replace('65536', '8192'),
		hash.replace('t=3', 't=1'),
		hash.replace('t=3', 't=99'),
		hash.replace('p=1', 'p=100'),
		hash.replace('v=19', 'v=16'),
		hash.replace('argon2id', 'argon2i'),
		hash + '=',
		'$2b$12$invalid',
	]) {
		expect(isOwnerPasswordHash(invalid)).toBe(false);
	}
});
test('owner mode fails startup without complete config and default remains standard', () => {
	const base = {DATABASE_URL: 'postgresql://localhost/test'};
	expect(envSchema.parse(base).AUTH_MODE).toBe('standard');
	expect(envSchema.safeParse({...base, AUTH_MODE: 'single-owner-password'}).success).toBe(false);
	expect(envSchema.safeParse({...base, AUTH_MODE: 'single-owner-password', OWNER_USERNAME: 'owner', OWNER_PASSWORD_HASH: hash, APP_URL: 'https://proxy.example'}).success).toBe(true);
	expect(envSchema.safeParse({...base, AUTH_MODE: 'typo'}).success).toBe(false);
});
test('owner mode only permits secure canonical origins or loopback HTTP', () => {
	const config = {DATABASE_URL: 'postgresql://localhost/test', AUTH_MODE: 'single-owner-password', OWNER_USERNAME: 'owner', OWNER_PASSWORD_HASH: hash};
	for (const APP_URL of ['???', 'file:///tmp', 'http://proxy.example', 'https://user:secret@proxy.example', 'https://proxy.example/path', 'https://proxy.example?x=1', 'https://proxy.example#hash']) {
		expect(envSchema.safeParse({...config, APP_URL}).success).toBe(false);
	}
	for (const APP_URL of ['https://proxy.example', 'http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) {
		expect(envSchema.safeParse({...config, APP_URL}).success).toBe(true);
	}
});

test('real Bun Argon2id hashes interoperate with bounded hash validation', async () => {
	const synthetic = 'test fixture password only';
	const actual = await Bun.password.hash(synthetic, {algorithm: 'argon2id', memoryCost: 65536, timeCost: 3});
	expect(isOwnerPasswordHash(actual)).toBe(true);
	expect(await Bun.password.verify(synthetic, actual)).toBe(true);
	expect(await Bun.password.verify('different test fixture', actual)).toBe(false);
});
