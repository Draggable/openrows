import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  BookOpenIcon,
  CircleHelpIcon,
  CodeIcon,
  ExternalLinkIcon,
  MoveRightIcon,
} from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui';
import { signInInfoQuery } from '../lib/auth';

/** The docs: openrows.io/docs, public, for hosted and self-hosted instances alike. */
export const DOCS_URL = 'https://openrows.io/docs';

/** The help menu's links to the docs site, in menu order. */
export const HELP_LINKS = [
  { label: 'Documentation', href: DOCS_URL, icon: BookOpenIcon },
  { label: 'Moving from Airtable', href: `${DOCS_URL}/airtable-migration`, icon: MoveRightIcon },
] as const;

/**
 * The top bar's "?" menu: the docs site, this instance's API reference and, when the server names
 * one (STATUS_PAGE_URL), its status page.
 */
export function HelpMenu() {
  const statusPageUrl = useQuery(signInInfoQuery).data?.statusPageUrl ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Help">
          <CircleHelpIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {HELP_LINKS.map(({ label, href, icon: Icon }) => (
          <DropdownMenuItem key={href} asChild>
            <a href={href} target="_blank" rel="noopener noreferrer">
              <Icon />
              <span className="flex-1">{label}</span>
              <ExternalLinkIcon aria-hidden />
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/docs/api">
            <CodeIcon />
            API reference
          </Link>
        </DropdownMenuItem>
        {statusPageUrl && (
          <DropdownMenuItem asChild>
            <a href={statusPageUrl} target="_blank" rel="noopener noreferrer">
              <ActivityIcon />
              <span className="flex-1">System status</span>
              <ExternalLinkIcon aria-hidden />
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
