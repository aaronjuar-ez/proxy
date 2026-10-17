import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link, useLoaderData, useSearchParams} from 'react-router';
import {
	devLogin,
	googleSignInUrl,
	requestMagicLink,
	passwordSignIn,
	type SignInMethods,
} from '@/client/auth-client';
import {GoogleIcon} from '@/components/google-icon';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {sanitizeCallbackUrl} from '@/lib/callback-url';

// The api's sign-in errors, from the `error` param of a redirect or the magic-link response.
const errorMessages: Record<string, string> = {
	Callback: 'There was an error during sign in. Please try again.',
	OAuthSignin: 'Could not start the sign in process. Please try again.',
	OAuthCallback: 'Could not complete sign in with Google. Please try again.',
	OAuthCreateAccount: 'Could not create an account with Google. Please try again.',
	OAuthAccountNotLinked: 'This email already has an account. Sign in with a magic link instead.',
	EmailSignin: 'Could not send the sign-in email. Please try again.',
	Verification: 'This sign-in link is invalid or has expired. Please request a new one.',
	SignupNotAllowed: 'This address cannot create an account here.',
	EmailNotVerified: 'Google has not verified this email address, so it cannot create an account.',
};

function errorMessage(code: string | undefined): string {
	return (code && errorMessages[code]) || 'An unexpected error occurred. Please try again.';
}

type Status =
	| {kind: 'idle'}
	| {kind: 'sending'}
	| {kind: 'sent'; logged: boolean}
	| {kind: 'error'; message: string};

// The terms and the privacy policy live on the website, whatever origin the app is on.
const WEBSITE_URL = 'https://personalagentproxy.com';

// All human sign-in methods use the same session and same-site callback. Signing up past the
// notice under the form accepts the terms, which the api records on the new account.
export function LoginPage() {
	const methods = useLoaderData<SignInMethods>();
	const [searchParams] = useSearchParams();
	const redirectError = searchParams.get('error');
	const callbackUrl = sanitizeCallbackUrl(searchParams.get('callbackUrl'));
	const [email, setEmail] = useState('');
	const [status, setStatus] = useState<Status>({kind: 'idle'});

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = email.trim();
		if (status.kind === 'sending' || trimmed.length === 0) {
			return;
		}
		setStatus({kind: 'sending'});

		const result = await requestMagicLink(trimmed, callbackUrl);
		if (result.isErr()) {
			setStatus({kind: 'error', message: errorMessage(undefined)});
			return;
		}

		if (!result.value.ok) {
			setStatus({kind: 'error', message: errorMessage(result.value.error)});
			return;
		}

		setStatus({kind: 'sent', logged: result.value.logged === true});
	}

	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
			<div className="grid w-72 gap-4">
				<h1 className="text-lg font-semibold">
					Personal Agent Proxy <span className="font-normal text-muted-foreground">for humans</span>
				</h1>
				<p className="text-sm text-balance text-muted-foreground">
					Agents aren't allowed to use this page.{' '}
					<Link to="/agent/login" className="text-foreground underline underline-offset-4">
						Go here instead!
					</Link>
				</p>
				{redirectError && status.kind === 'idle' && (
					<p className="text-sm text-destructive">
						{methods.password
							? 'Could not sign in. Please try again.'
							: errorMessage(redirectError)}
					</p>
				)}
				{!methods.password && methods.google && (
					<>
						<Button
							variant="outline"
							onClick={() => {
								window.location.href = googleSignInUrl(callbackUrl);
							}}
						>
							<GoogleIcon />
							Continue with Google
						</Button>
						<p className="text-center text-sm text-muted-foreground">or</p>
					</>
				)}
				{methods.password && <PasswordLoginForm callbackUrl={callbackUrl} />}
				{!methods.password && methods.email && (
					<form className="grid gap-4" onSubmit={(event) => void onSubmit(event)}>
						<div className="grid gap-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								autoComplete="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
						</div>
						<Button type="submit" disabled={email.trim().length === 0 || status.kind === 'sending'}>
							Send sign-in link
						</Button>
						{status.kind === 'sent' && (
							<p className="text-sm text-muted-foreground">
								{status.logged
									? 'Sending email is not set up yet, so the sign-in link was written to the server log.'
									: 'Check your email for a link to sign in.'}
							</p>
						)}
						{status.kind === 'error' && (
							<p className="text-sm text-destructive">{status.message}</p>
						)}
					</form>
				)}
				{!methods.password && (methods.email || methods.google) && (
					<p className="text-sm text-balance text-muted-foreground">
						By continuing, you agree to the{' '}
						<a
							href={`${WEBSITE_URL}/terms/`}
							target="_blank"
							rel="noreferrer"
							className="text-foreground underline underline-offset-4"
						>
							Terms of Service
						</a>{' '}
						and{' '}
						<a
							href={`${WEBSITE_URL}/privacy/`}
							target="_blank"
							rel="noreferrer"
							className="text-foreground underline underline-offset-4"
						>
							Privacy Policy
						</a>
						.
					</p>
				)}
				{!methods.password && methods.dev && <DevLoginButton callbackUrl={callbackUrl} />}
				{!methods.password && !methods.email && !methods.google && !methods.dev && (
					<>
						<p role="alert" className="text-sm text-destructive">
							Sign-in is temporarily unavailable. Please try again.
						</p>
						<Button variant="outline" onClick={() => window.location.reload()}>
							Try again
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

// Development only: the same dev user every time, signed in at once, without Google or an email.
function DevLoginButton({callbackUrl}: {callbackUrl: string | undefined}) {
	const [loading, setLoading] = useState(false);

	return (
		<Button
			variant="secondary"
			disabled={loading}
			onClick={async () => {
				setLoading(true);
				const result = await devLogin();
				if (result.isErr()) {
					setLoading(false);
					return;
				}
				window.location.href = callbackUrl ?? '/';
			}}
		>
			Log in as dev user
		</Button>
	);
}

// Abort on navigation and ignore late responses, so an interrupted login cannot redirect a
// newer page. The ref also blocks multiple submits before React has rendered the busy state.
function PasswordLoginForm({callbackUrl}: {callbackUrl: string | undefined}) {
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [status, setStatus] = useState<Status>({kind: 'idle'});
	const pending = useRef<AbortController | null>(null);
	useEffect(() => () => pending.current?.abort(), []);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending.current || !username.trim() || !password) {
			return;
		}
		const controller = new AbortController();
		pending.current = controller;
		setStatus({kind: 'sending'});
		const request = passwordSignIn(username.trim(), password, controller.signal);
		setPassword('');
		const result = await request;
		if (controller.signal.aborted) {
			return;
		}
		pending.current = null;
		if (result.isErr()) {
			setStatus({kind: 'error', message: 'Could not sign in. Please try again.'});
			return;
		}
		if ('error' in result.value) {
			const message =
				result.value.error === 'TooManyAttempts'
					? 'Too many sign-in attempts. Please wait a few minutes and try again.'
					: 'Could not sign in. Check your username and password and try again.';
			setStatus({kind: 'error', message});
			return;
		}
		window.location.href = callbackUrl ?? '/';
	}

	const loading = status.kind === 'sending';
	return (
		<form className="grid gap-4" aria-busy={loading} onSubmit={(event) => void onSubmit(event)}>
			<div className="grid gap-2">
				<Label htmlFor="username">Username</Label>
				<Input
					id="username"
					name="username"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					required
					value={username}
					disabled={loading}
					onChange={(event) => setUsername(event.target.value)}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="current-password"
					required
					value={password}
					disabled={loading}
					onChange={(event) => setPassword(event.target.value)}
				/>
			</div>
			<Button type="submit" disabled={loading || !username.trim() || !password}>
				{loading ? 'Signing in…' : 'Sign in'}
			</Button>
			{status.kind === 'error' && (
				<p role="alert" className="text-sm text-destructive">
					{status.message}
				</p>
			)}
		</form>
	);
}
