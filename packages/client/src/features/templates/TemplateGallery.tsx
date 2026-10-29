import type { MeResponse, TemplateSummary } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, LayoutTemplateIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { templateQueries } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Spinner,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import { categoriesOf, inCategory, previewTable, templateStats } from './model';
import { useInstallTemplate } from './useInstallTemplate';

/**
 * "Start from a template": the built-in templates by category, a preview of one (its
 * tables, fields and first records) and "Use template", which installs it into `workspaceId` (or
 * the first workspace where the person creates bases) and opens the new base.
 */
export function TemplateGallery({
  me,
  open,
  onOpenChange,
  workspaceId,
  initialSlug,
}: {
  me: MeResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string | undefined;
  /** Opens straight on this template's preview (openrows.io/templates links here). */
  initialSlug?: string | undefined;
}) {
  const list = useQuery({ ...templateQueries.list(), enabled: open });
  const [category, setCategory] = useState('All');
  const [slug, setSlug] = useState<string | undefined>(initialSlug);
  useEffect(() => {
    if (open) setSlug(initialSlug);
  }, [open, initialSlug]);
  const templates = list.data?.templates ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-[960px] content-start overflow-y-auto">
        {slug ? (
          <TemplatePreview
            me={me}
            slug={slug}
            workspaceId={workspaceId}
            onBack={() => setSlug(undefined)}
            onInstalled={() => onOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Start from a template</DialogTitle>
              <DialogDescription>
                Tables, fields, views and sample records, ready to edit. Preview one, then use it.
              </DialogDescription>
            </DialogHeader>
            <div role="toolbar" aria-label="Categories" className="flex flex-wrap gap-1.5">
              {categoriesOf(templates).map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={c === category ? 'default' : 'secondary'}
                  aria-pressed={c === category}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </Button>
              ))}
            </div>
            {list.isPending ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-28 rounded-lg" />
                ))}
              </div>
            ) : list.isError ? (
              <p role="alert" className="text-danger">
                The templates couldn't be loaded. Try again later.
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Templates">
                {inCategory(templates, category).map((t) => (
                  <li key={t.slug}>
                    <TemplateTile template={t} onSelect={() => setSlug(t.slug)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TemplateTile({
  template,
  onSelect,
  className,
}: {
  template: TemplateSummary;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${template.name} template`}
      className={cn(
        'flex h-full w-full flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-left shadow-1 hover:bg-hover',
        className
      )}
    >
      <span className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-sm bg-hover text-text-2">
          <LayoutTemplateIcon className="size-4" />
        </span>
        <span className="font-semibold">{template.name}</span>
        <span className="ml-auto text-small text-text-2">{template.category}</span>
      </span>
      <span className="line-clamp-2 text-text-2">{template.description}</span>
      <span className="mt-auto pt-1 text-small text-text-2">{templateStats(template)}</span>
    </button>
  );
}

function TemplatePreview({
  me,
  slug,
  workspaceId,
  onBack,
  onInstalled,
}: {
  me: MeResponse;
  slug: string;
  workspaceId?: string | undefined;
  onBack: () => void;
  onInstalled: () => void;
}) {
  const template = useQuery(templateQueries.detail(slug));
  const install = useInstallTemplate(me);
  const [tab, setTab] = useState(0);
  const preview = template.data ? previewTable(template.data, tab) : null;

  if (template.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }
  if (template.isError || !template.data) {
    return (
      <div className="grid gap-3">
        <DialogTitle>Template not found</DialogTitle>
        <p className="text-text-2">There's no template "{slug}".</p>
        <div>
          <Button variant="secondary" onClick={onBack}>
            <ArrowLeftIcon />
            All templates
          </Button>
        </div>
      </div>
    );
  }
  const t = template.data;
  const error =
    install.error instanceof ApiError
      ? install.error.message
      : install.error
        ? "The base couldn't be created. Try again."
        : null;

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="All templates">
            <ArrowLeftIcon />
          </Button>
          <DialogTitle>{t.name}</DialogTitle>
          <span className="text-small text-text-2">{t.category}</span>
        </div>
        <DialogDescription>{t.description}</DialogDescription>
      </DialogHeader>
      <div
        role="tablist"
        aria-label="Tables"
        className="flex flex-wrap gap-1 border-b border-border"
      >
        {t.tables.map((table, i) => (
          <button
            key={table.id}
            type="button"
            role="tab"
            aria-selected={i === tab}
            onClick={() => setTab(i)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-body',
              i === tab
                ? 'border-primary font-semibold text-text'
                : 'border-transparent text-text-2 hover:text-text'
            )}
          >
            {table.name}
          </button>
        ))}
      </div>
      {preview && (
        <div role="tabpanel" aria-label={preview.name} className="grid min-w-0 gap-3">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left text-body">
              <thead>
                <tr className="bg-hover">
                  {preview.fields.map((f) => (
                    <th
                      key={f.id}
                      scope="col"
                      className="h-[34px] border-b border-border px-2 font-[550] whitespace-nowrap"
                    >
                      {f.name}
                      <span className="block text-small font-normal text-text-2">{f.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    {preview.fields.map((f) => (
                      <td key={f.id} className="h-[34px] max-w-[220px] truncate px-2">
                        {r.cells[f.id]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-small text-text-2">
            {preview.records > preview.rows.length
              ? `The first ${preview.rows.length} of ${preview.records} records. `
              : ''}
            Computed fields fill in once the base is created.
            {t.automations.length > 0 &&
              ` Includes ${t.automations.length} automation${t.automations.length === 1 ? '' : 's'}, off until you turn ${t.automations.length === 1 ? 'it' : 'them'} on.`}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          disabled={install.isPending}
          onClick={() =>
            install.mutate(
              { slug: t.slug, ...(workspaceId ? { workspaceId } : {}) },
              { onSuccess: onInstalled }
            )
          }
        >
          {install.isPending && <Spinner />}
          {install.isPending ? 'Creating the base…' : 'Use template'}
        </Button>
      </div>
    </div>
  );
}
