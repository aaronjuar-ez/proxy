import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {expect, test} from 'bun:test';
const root = new URL('../../../../', import.meta.url);
const file = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('Vercel container starts the API directly without cold-start migrations or baked-in credentials', () => {
	const docker = file('Dockerfile.vercel');
	expect(docker).toContain('CMD ["bun", "packages/api/src/index.ts"]');
	expect(docker).not.toMatch(/^ENTRYPOINT/m);
	expect(docker).not.toContain('COPY docker-entrypoint.sh');
	expect(docker).not.toContain('prisma migrate deploy');
	expect(docker).toContain('USER bun');
	expect(docker).toContain('ENV PORT=4000');
	expect(docker).toContain('COPY --from=build /app/packages/web/dist packages/web/dist');
	expect(docker).not.toMatch(/^(?:ARG|ENV)\s+(?:DATABASE_URL|AUTH_SECRET|ENCRYPTION_KEY)/m);
	expect(file('.dockerignore')).toContain('.env*');
});

test('both container runtime stages copy every workspace manifest for the frozen lockfile', () => {
	const packages = readdirSync(new URL('packages/', root)).filter((name) => existsSync(new URL(`packages/${name}/package.json`, root)));
	for (const name of ['Dockerfile', 'Dockerfile.vercel']) {
		const runtime = file(name).split('AS runtime')[1]!;
		for (const workspace of packages) expect(runtime).toContain(`COPY packages/${workspace}/package.json packages/${workspace}/`);
		expect(runtime).toContain("bun install --frozen-lockfile --production --filter '@proxy/api'");
	}
});
