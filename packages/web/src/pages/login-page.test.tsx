/// <reference types="bun" />
import {afterAll, afterEach, expect, spyOn, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {getSignInMethods, type SignInMethods} from '@/client/auth-client';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {LoginPage} from './login-page';

const owner = {
	password: true,
	email: false,
	google: false,
	dev: false,
	needs: {google: false, plaid: false},
};
const standard = {
	password: false,
	email: true,
	google: true,
	dev: true,
	needs: {google: false, plaid: false},
};
const originalFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch');
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
	cleanup();
	fetchSpy.mockReset();
	window.location.href = 'http://localhost/';
});

function mockResponse(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	fetchSpy.mockImplementation(Object.assign(handler, {preconnect: originalFetch.preconnect}));
}

function renderLogin(methods: SignInMethods = owner, query = '') {
	const router = createMemoryRouter(
		[
			{path: '/login', loader: () => methods, element: <LoginPage />},
			{path: '/agent/login', element: <p>Agent login</p>},
		],
		{initialEntries: [`/login${query}`]},
	);
	render(<RouterProvider router={router} />);
	return router;
}

async function fillPassword() {
	const username = await screen.findByLabelText('Username');
	const password = screen.getByLabelText('Password');
	fireEvent.change(username, {target: {value: 'owner'}});
	fireEvent.change(password, {target: {value: 'test-only-password'}});
	return {username, password};
}

test('password mode offers username and current password, preserving agent login only', async () => {
	renderLogin({...standard, password: true}); // Password mode wins even over inconsistent flags.
	const {username, password} = await fillPassword();
	expect(username.getAttribute('autocomplete')).toBe('username');
	expect(password.getAttribute('autocomplete')).toBe('current-password');
	expect(password.getAttribute('type')).toBe('password');
	expect(screen.queryByLabelText('Email')).toBeNull();
	expect(screen.queryByRole('button', {name: 'Continue with Google'})).toBeNull();
	expect(screen.queryByRole('button', {name: 'Log in as dev user'})).toBeNull();
	expect(screen.getByRole('link', {name: 'Go here instead!'}).getAttribute('href')).toBe(
		'/agent/login',
	);
});

test('standard mode keeps email, Google and server-authorized development login', async () => {
	renderLogin(standard);
	await screen.findByLabelText('Email');
	expect(screen.getByRole('button', {name: 'Continue with Google'})).toBeTruthy();
	expect(screen.getByRole('button', {name: 'Log in as dev user'})).toBeTruthy();
	expect(screen.queryByLabelText('Password')).toBeNull();
});

test('method availability failure offers retry without guessing a sign-in method', async () => {
	renderLogin({
		password: false,
		email: false,
		google: false,
		dev: false,
		needs: {google: false, plaid: false},
	});
	expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable');
	expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy();
	expect(screen.queryByLabelText('Email')).toBeNull();
});

test('methods client validates all mode flags and rejects incomplete responses', async () => {
	mockResponse(async () => Response.json(owner));
	expect((await getSignInMethods()).unwrap()).toEqual(owner);
	mockResponse(async () => Response.json({google: true}));
	expect((await getSignInMethods()).isErr()).toBe(true);
});

test('repeated failures clear the password, remain retryable and never echo server details', async () => {
	let attempts = 0;
	mockResponse(async (url, init) => {
		expect(String(url)).toBe('/auth/password');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({
			username: 'owner',
			password: 'test-only-password',
		});
		attempts += 1;
		return Response.json(
			{error: attempts === 3 ? 'TooManyAttempts' : 'Private server detail'},
			{status: attempts === 3 ? 429 : 401},
		);
	});
	renderLogin();
	for (let i = 0; i < 3; i += 1) {
		const {password} = await fillPassword();
		fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));
		expect(password).toHaveProperty('value', '');
		await screen.findByRole('alert');
		expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
		expect(screen.queryByText('Private server detail')).toBeNull();
	}
	expect(attempts).toBe(3);
	expect(screen.getByRole('alert').textContent).toContain('Too many sign-in attempts');
});

test('network interruption clears credentials and allows another attempt', async () => {
	mockResponse(async () => {
		throw new Error('offline');
	});
	renderLogin();
	const {password} = await fillPassword();
	fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));
	expect((await screen.findByRole('alert')).textContent).toBe(
		'Could not sign in. Please try again.',
	);
	expect(password).toHaveProperty('value', '');
	expect(password).toHaveProperty('disabled', false);
});

test('duplicate submissions are blocked and leaving aborts without a late redirect', async () => {
	let resolveResponse: (response: Response) => void = () => {};
	let signal: AbortSignal | null | undefined;
	mockResponse(async (_input, init) => {
		signal = init?.signal;
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
	});
	const router = renderLogin(owner, '?callbackUrl=%2Fconnections');
	const {password} = await fillPassword();
	const form = password.closest('form')!;
	fireEvent.submit(form);
	fireEvent.submit(form);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	expect(screen.getByRole('button', {name: 'Signing in…'})).toHaveProperty('disabled', true);
	expect(password).toHaveProperty('value', '');
	await act(async () => {
		await router.navigate('/agent/login');
	});
	expect(signal?.aborted).toBe(true);
	await act(async () => {
		resolveResponse(Response.json({ok: true}));
	});
	expect(screen.getByText('Agent login')).toBeTruthy();
	expect(window.location.pathname).toBe('/');
});

test.each([
	'/connections?view=all',
	'//evil.example',
	'/\\evil.example',
	'https://evil.example',
	'/\n/evil.example',
])('successful login only follows a safe callback: %s', async (callback) => {
	mockResponse(async () => Response.json({ok: true}));
	renderLogin(owner, `?callbackUrl=${encodeURIComponent(callback)}`);
	const {password} = await fillPassword();
	fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));
	await waitFor(() =>
		expect(window.location.href).toBe(`http://localhost${sanitizeCallbackUrl(callback) ?? '/'}`),
	);
	expect(password).toHaveProperty('value', '');
});

test('callback sanitization rejects browser-normalized external destinations', () => {
	for (const value of [
		'//evil.example',
		'/\\evil.example',
		'/\n/evil.example',
		'/\t/evil.example',
		'https://evil.example',
		'javascript:alert(1)',
	]) {
		expect(sanitizeCallbackUrl(value)).toBeUndefined();
	}
	expect(sanitizeCallbackUrl('/connections?view=all')).toBe('/connections?view=all');
});

test('password mode redirect errors do not suggest disabled email methods', async () => {
	renderLogin(owner, '?error=OAuthAccountNotLinked');
	await screen.findByLabelText('Username');
	expect(screen.getByText('Could not sign in. Please try again.')).toBeTruthy();
	expect(screen.queryByText(/magic link instead/)).toBeNull();
});
