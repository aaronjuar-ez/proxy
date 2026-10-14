import type {CSSProperties} from 'react';
import Link from 'next/link';
import {ThemeToggle} from '@/components/theme-toggle';

const EXTERNAL_LINKS = [
	{label: 'Docs', href: 'https://docs.personalagentproxy.com'},
	{label: 'GitHub', href: 'https://github.com/personalagentproxy/proxy'},
];

const PAGE_LINKS = [
	{label: 'Privacy', href: '/privacy/'},
	{label: 'Terms', href: '/terms/'},
];

// Every page's footer, at the bottom when the page is shorter than the window: the theme, the docs
// and the code in a new tab, and the privacy policy and the terms.
export function SiteFooter({className = '', style}: {className?: string; style?: CSSProperties}) {
	return (
		<footer
			className={`mt-auto flex justify-start gap-4 pt-24 pb-8 text-sm text-muted-foreground ${className}`}
			style={style}
		>
			<div className="flex items-center gap-4">
				<ThemeToggle />
				{EXTERNAL_LINKS.map((link) => (
					<a
						key={link.href}
						className="hover:text-foreground"
						href={link.href}
						target="_blank"
						rel="noopener noreferrer"
					>
						{link.label}
					</a>
				))}
				{PAGE_LINKS.map((link) => (
					<Link key={link.href} className="hover:text-foreground" href={link.href}>
						{link.label}
					</Link>
				))}
			</div>
		</footer>
	);
}
