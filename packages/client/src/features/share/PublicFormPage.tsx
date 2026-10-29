import {
  type AttachmentValue,
  downloads,
  type FieldMeta,
  MAX_FORM_FILES_PER_FIELD,
  MAX_FORM_UPLOAD_BYTES,
  type PublicForm,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { PaperclipIcon, XIcon } from 'lucide-react';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { ApiError, api, downloadUrl, putToStorage } from '../../api/client';
import { formQueries } from '../../api/queries';
import { MadeWith } from '../../app/Logo';
import { Button, Skeleton } from '../../components/ui';
import { cn } from '../../lib/utils';
import { RichText } from '../grid/cells/RichText';
import { PreviewInput } from '../views/form/FormPreview';
import { FormLinkAnswer } from './FormLinkAnswer';
import {
  fieldErrors,
  formFieldMeta,
  initialAnswers,
  missingAnswers,
  redirectTarget,
  shownFields,
  submissionFields,
} from './form-model';
import { usePrivatePage } from './SharedViewPage';
import { useTurnstile } from './turnstile';

/**
 * The public form page, `/f/<token>`: anyone with the link fills it in, signed in or
 * not. Conditional fields follow the answers, prefilled fields come from the URL
 * (`prefill_<Field name>=`, hidden with `hide_<Field name>=true`), files upload through the
 * form's own upload path, linked records are picked from the view the form offers, and a
 * Turnstile CAPTCHA guards the submit when the server has one.
 */
export function PublicFormPage({ token }: { token: string }) {
  const query = useQuery(formQueries.form(token));
  usePrivatePage(query.data?.title);
  if (query.isPending) {
    return (
      <Page>
        <div className="grid gap-4 p-8">
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </Page>
    );
  }
  if (!query.data) {
    return (
      <Page>
        <div className="grid gap-2 p-8" data-testid="form-unavailable">
          <h1 className="text-title font-semibold">This form isn’t available</h1>
          <p className="text-text-2">
            The link may have been turned off, or the form was removed. Ask whoever sent it for a
            new one.
          </p>
        </div>
      </Page>
    );
  }
  if (!query.data.accepting) return <NotAccepting form={query.data} />;
  return <FilledForm token={token} form={query.data} />;
}

/**
 * The base is at its plan's records per base: visitors learn only that the form takes no
 * responses for now (the owners are told by email).
 */
function NotAccepting({ form }: { form: PublicForm }) {
  return (
    <Page branding={form.showBranding}>
      <div className="grid gap-2 p-8 max-sm:p-5" role="status" data-testid="form-not-accepting">
        <h1 className="text-title font-semibold">{form.title}</h1>
        <p className="text-text-2">This form isn’t accepting responses right now.</p>
        <p className="text-small text-text-2">
          Its owner has been told. Try again later, or contact whoever sent you the link.
        </p>
      </div>
    </Page>
  );
}

function Page({ children, branding = true }: { children: React.ReactNode; branding?: boolean }) {
  return (
    <main className="min-h-dvh bg-app px-6 py-8 max-sm:px-3 max-sm:py-4">
      <div className="mx-auto max-w-[640px] overflow-hidden rounded-lg border border-border bg-surface shadow-1">
        {children}
      </div>
      {branding && (
        <p className="mt-4 text-center">
          <MadeWith />
        </p>
      )}
    </main>
  );
}

const newSubmissionId = () => crypto.randomUUID();

function FilledForm({ token, form }: { token: string; form: PublicForm }) {
  const fields = useMemo(() => form.fields.map(formFieldMeta), [form.fields]);
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const prefill = useMemo(() => initialAnswers(form, window.location.search), [form]);
  const [answers, setAnswers] = useState<Record<string, unknown>>(prefill.answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [full, setFull] = useState(false);
  const [uploading, setUploading] = useState(0);
  const captcha = useTurnstile(form.captchaSiteKey);
  const shown = shownFields(form, answers, fields);
  const set = (fieldId: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [fieldId]: value }));
    setErrors(({ [fieldId]: _, ...rest }) => rest);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = missingAnswers(form, answers, fields);
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((id) => [id, 'An answer is required.'])));
      setProblem('Some answers are missing.');
      document.getElementById(`form-field-${missing[0]}`)?.focus();
      return;
    }
    if (form.captchaSiteKey && !captcha.token) {
      setProblem('Complete the CAPTCHA check, then submit.');
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      await api.forms.submit({
        params: { formToken: token },
        body: {
          submissionId,
          fields: submissionFields(form, answers, fields),
          ...(captcha.token ? { captchaToken: captcha.token } : {}),
        },
      });
      const target = redirectTarget(form);
      if (target) {
        window.location.assign(target);
        return;
      }
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED' && err.status === 403) {
        setFull(true);
        return;
      }
      const byField = fieldErrors(err);
      setErrors(byField);
      captcha.reset();
      setProblem(
        err instanceof ApiError && err.status === 429
          ? 'Too many submissions from here. Try again in a few minutes.'
          : err instanceof ApiError && err.code === 'CAPTCHA_FAILED'
            ? 'The CAPTCHA check failed. Try it again, then submit.'
            : Object.keys(byField).length > 0
              ? 'Some answers need another look.'
              : 'The form couldn’t be sent. Try again.'
      );
    } finally {
      setSending(false);
    }
  };

  if (full) return <NotAccepting form={form} />;
  if (done) {
    return (
      <Page branding={form.showBranding}>
        <div className="grid gap-4 p-8 max-sm:p-5" role="status" data-testid="form-submitted">
          <h1 className="text-title font-semibold">Thanks for your answers</h1>
          {form.submitMessage ? (
            <RichText text={form.submitMessage} links={false} className="text-text-2" />
          ) : (
            <p className="text-text-2">Your response was sent.</p>
          )}
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setAnswers(prefill.answers);
                setSubmissionId(newSubmissionId());
                setDone(false);
              }}
            >
              Submit another response
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  const image = (which: 'cover' | 'logo') =>
    downloadUrl(downloads.formImage, { params: { formToken: token, image: which } });
  return (
    <Page branding={form.showBranding}>
      {form.hasCover && <img src={image('cover')} alt="" className="h-40 w-full object-cover" />}
      <div className="grid gap-6 p-8 max-sm:p-5">
        <header className="grid gap-2">
          {form.hasLogo && (
            <img
              src={image('logo')}
              alt="Logo"
              className="h-12 w-auto max-w-[200px] object-contain object-left"
            />
          )}
          <h1 className="text-title font-semibold">{form.title}</h1>
          {form.description && (
            <RichText text={form.description} links={false} className="text-text-2" />
          )}
        </header>
        <form aria-label={form.title} className="grid gap-5" noValidate onSubmit={submit}>
          {form.entries.map((entry) => {
            const field = byId.get(entry.fieldId);
            if (!field || !shown.has(field.id) || prefill.hidden.has(field.id)) return null;
            const id = `form-field-${field.id}`;
            const error = errors[field.id];
            return (
              <div key={field.id} className="grid gap-1.5" data-testid="form-field">
                <label htmlFor={id} className="font-[550]">
                  {entry.label?.trim() || field.name}
                  {entry.required && (
                    <span className="ml-0.5 text-danger" aria-hidden>
                      *
                    </span>
                  )}
                  {entry.required && <span className="sr-only"> (required)</span>}
                </label>
                {entry.helpText?.trim() && (
                  <RichText
                    text={entry.helpText}
                    links={false}
                    className="text-small text-text-2"
                  />
                )}
                {field.type === 'link' ? (
                  <FormLinkAnswer
                    id={id}
                    token={token}
                    field={field}
                    value={answers[field.id]}
                    onChange={(v) => set(field.id, v)}
                  />
                ) : field.type === 'attachment' ? (
                  <FileAnswer
                    id={id}
                    token={token}
                    field={field}
                    value={answers[field.id]}
                    onChange={(v) => set(field.id, v)}
                    onBusy={(d) => setUploading((n) => n + d)}
                  />
                ) : (
                  <PreviewInput
                    id={id}
                    field={field}
                    value={answers[field.id]}
                    required={!!entry.required}
                    onChange={(v) => set(field.id, v)}
                  />
                )}
                {error && (
                  <p className="text-small text-danger" id={`${id}-error`}>
                    {error}
                  </p>
                )}
              </div>
            );
          })}
          {form.captchaSiteKey && <div ref={captcha.ref} data-testid="form-captcha" />}
          {problem && (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}
          <div>
            <Button type="submit" disabled={sending || uploading > 0}>
              {sending ? 'Sending…' : form.submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </Page>
  );
}

/** The files of an attachment answer: upload through the form, remove before submitting. */
function FileAnswer({
  id,
  token,
  field,
  value,
  onChange,
  onBusy,
}: {
  id: string;
  token: string;
  field: FieldMeta;
  value: unknown;
  onChange: (value: AttachmentValue[]) => void;
  onBusy: (delta: number) => void;
}) {
  const files = Array.isArray(value) ? (value as AttachmentValue[]) : [];
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(files);
  latest.current = files;
  const add = async (picked: File[]) => {
    setError(null);
    for (const file of picked) {
      if (latest.current.length >= MAX_FORM_FILES_PER_FIELD) {
        setError(`At most ${MAX_FORM_FILES_PER_FIELD} files.`);
        return;
      }
      if (file.size === 0 || file.size > MAX_FORM_UPLOAD_BYTES) {
        setError(`"${file.name}" must be at most ${MAX_FORM_UPLOAD_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      onBusy(1);
      try {
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : '';
        const { attachment, upload } = await api.forms.upload({
          params: { formToken: token },
          body: { fieldId: field.id, filename: file.name, type, size: file.size },
        });
        await putToStorage(upload, file);
        const ready = await api.forms.confirmUpload({
          params: { formToken: token, attachmentId: attachment.id },
        });
        const next = [...latest.current, ready];
        latest.current = next;
        onChange(next);
      } catch {
        setError(`"${file.name}" couldn’t be uploaded.`);
      } finally {
        onBusy(-1);
      }
    }
  };
  return (
    <div className="grid gap-2">
      <label
        className={cn(
          'flex h-8 w-fit cursor-pointer items-center gap-2 rounded-sm border border-border px-2.5 hover:bg-hover',
          'focus-within:border-brand'
        )}
      >
        <PaperclipIcon aria-hidden className="size-4 text-text-2" />
        Add files
        <input
          id={id}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = '';
            void add(picked);
          }}
        />
      </label>
      {files.length > 0 && (
        <ul className="grid gap-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-small">
              <span className="min-w-0 truncate">{f.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                className="rounded-xs p-0.5 text-text-2 hover:bg-hover"
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-small text-danger">{error}</p>}
    </div>
  );
}
