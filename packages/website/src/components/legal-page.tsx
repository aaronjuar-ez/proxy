import type {ReactNode} from 'react';
import Link from 'next/link';
import {ArrowLeftIcon} from 'lucide-react';
import {SiteFooter} from '@/components/site-footer';
import {LEGAL_EFFECTIVE_DATE} from '@/lib/legal';

// The privacy policy and the terms: the home page's column, a way back to it, the title and the
// date it took effect, then the sections.
export function LegalPage({title, children}: {title: string; children: ReactNode}) {
	return (
		<main className="flex min-h-dvh w-full justify-center bg-background px-6 text-foreground">
			<div className="flex w-full max-w-xl flex-col">
				<div className="grid gap-10 pt-16">
					<Link
						href="/"
						className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
					>
						<ArrowLeftIcon className="size-4" />
						Personal Agent Proxy
					</Link>
					<div className="grid gap-2">
						<h1 className="text-2xl font-medium">{title}</h1>
						<p className="text-sm text-muted-foreground">Effective {LEGAL_EFFECTIVE_DATE}</p>
					</div>
					{children}
				</div>
				<SiteFooter />
			</div>
		</main>
	);
}

export function LegalSection({title, children}: {title: string; children: ReactNode}) {
	return (
		<section className="grid gap-3 text-sm text-muted-foreground">
			<h2 className="font-medium text-foreground">{title}</h2>
			{children}
		</section>
	);
}

export function LegalList({children}: {children: ReactNode}) {
	return <ul className="grid list-disc gap-2 pl-5">{children}</ul>;
}

export function LegalLink({href, children}: {href: string; children: ReactNode}) {
	return (
		<a className="text-foreground underline underline-offset-4" href={href}>
			{children}
		</a>
	);
}
