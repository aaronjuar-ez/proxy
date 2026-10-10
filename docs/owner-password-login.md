# Single-owner dashboard login

This optional mode gives one person a username/password dashboard login without an email provider or Google OAuth setup. It does **not** remove authentication, change agent OAuth/bearer authentication, or weaken per-agent permissions.

## Configure before exposing the app

Set these server-side environment variables, using the hosting platform's secret UI for the hash:

- `AUTH_MODE=single-owner-password`
- `OWNER_USERNAME`: your case-sensitive username, 1–64 ASCII letters/digits/dots/underscores/hyphens, starting with a letter or digit
- `OWNER_PASSWORD_HASH`: an Argon2id hash generated locally as below
- `APP_URL`: the canonical HTTPS origin
- `DATABASE_URL` and the stable `ENCRYPTION_KEY` as described in [the hosting guide](custom-mcp-hosting.md)

Incomplete or invalid owner configuration must fail closed, never revert to public email signup. In this mode, email, Google, and development login routes are disabled. The login screen contains only the username/password form. `AUTH_SECRET` is not used by owner password login (Compose still expects it for compatibility with its standard-mode settings). You do not need `RESEND_KEY`, `EMAIL_FROM`, Google credentials, or an email allowlist for this mode.

There is no public setup or “claim the first administrator” endpoint. The first successful configured-password login creates a dedicated owner and workspace transactionally. Existing users are not adopted by matching an email address; switching an existing multi-user installation to this mode does not transfer its workspaces or grant their access to the new owner. Use a fresh database for a new personal deployment.

## Generate the hash privately

On your own trusted computer, in a private interactive terminal with Bun installed, run:

```sh
bun scripts/hash-owner-password.mjs
```

The helper asks for the password twice without echoing it. Use a unique password or passphrase of at least 15 characters; a password manager can generate and remember it. The helper prints only the Argon2id hash, using 64 MiB of memory and three iterations. It refuses password command-line arguments and noninteractive input. Do not type a real password into a shell command, chat, source file, or cloud build log.

For Docker Compose, use an image built from this fork with this feature; the upstream image does not include it. If storing the hash in a private `.env`, enclose its value in single quotes to preserve dollar signs. Never commit that file.

Paste the resulting hash directly into the hosting platform's secret `OWNER_PASSWORD_HASH` field and save it yourself. Treat the hash as sensitive: an attacker who obtains it can attempt offline password guesses. Do not share it in chat or commit it. Clear private terminal output when finished. No actual user password or hash is provided by this repository.

Password hashing uses [Bun's built-in Argon2id implementation](https://bun.sh/docs/runtime/hashing). This avoids storing the plaintext password on the application server.

## Runtime protections and recovery

- Login uses the existing same-origin browser request guard and host-only, HttpOnly, Secure-on-HTTPS, SameSite=Lax session cookies. Keep the service on HTTPS.
- Credential failures are generic. A database-atomic global budget allows five attempts per minute across all replicas, in a fixed 60-second window, before expensive Argon2 verification. Database errors fail closed. This deliberately limits distributed guessing and memory use, but an attacker can consume the small budget and temporarily prevent owner login; it is not a full edge denial-of-service defense.
- Only the dedicated owner's password-mode sessions can access the dashboard in this mode. Changing the configured username or password hash invalidates previous owner sessions. Agent tokens and their permission grants are separate.
- There is no email reset flow. To recover or change your password, generate a new hash privately, replace `OWNER_PASSWORD_HASH` in your hosting secret settings, and redeploy all instances consistently. Keep the database and `ENCRYPTION_KEY` unchanged. Remove old deployments that still use the old configuration from public access.
- Keep `ENCRYPTION_KEY` backed up with the database. It is still required to protect stored upstream credentials; a dashboard password does not replace it.

The owner login is for a sole operator, not a multi-user password account system. There is no registration, username lookup, password-management API, MFA, or automatic transfer of existing accounts in this initial mode.
