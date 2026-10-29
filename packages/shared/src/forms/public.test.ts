import { describe, expect, it } from 'vitest';
import {
  createFormUploadSchema,
  formLinkRecordsQuerySchema,
  formSubmissionSchema,
  isPublicFormFieldType,
  MAX_FORM_LINK_PAGE,
  MAX_FORM_UPLOAD_BYTES,
  prefillAnswers,
  publicFormFieldProblem,
} from './public.js';

const ids = {
  name: '01900000-0000-7000-8000-000000000001',
  kind: '01900000-0000-7000-8000-000000000002',
  age: '01900000-0000-7000-8000-000000000003',
  secret: '01900000-0000-7000-8000-000000000004',
};

const fields = [
  { id: ids.name, name: 'Name', type: 'singleLineText', options: {} },
  {
    id: ids.kind,
    name: 'Kind',
    type: 'singleSelect',
    options: {
      choices: [
        { id: 'bug', name: 'Bug', color: 'red' },
        { id: 'idea', name: 'Idea', color: 'green' },
      ],
    },
  },
  { id: ids.age, name: 'Age', type: 'number', options: {} },
  { id: ids.secret, name: 'Secret', type: 'singleLineText', options: {} },
];

const entries = [
  { fieldId: ids.name, allowPrefill: true },
  { fieldId: ids.kind, allowPrefill: true },
  { fieldId: ids.age, allowPrefill: true },
  { fieldId: ids.secret },
];

describe('isPublicFormFieldType', () => {
  it('admits what a person types or picks, and links; not people or computed fields', () => {
    for (const t of [
      'singleLineText',
      'number',
      'singleSelect',
      'attachment',
      'checkbox',
      'link',
    ]) {
      expect(isPublicFormFieldType(t), t).toBe(true);
    }
    for (const t of ['user', 'formula', 'autoNumber', 'createdTime', 'button', 'nope']) {
      expect(isPublicFormFieldType(t), t).toBe(false);
    }
  });
});

describe('publicFormFieldProblem (#121)', () => {
  const view = '01900000-0000-7000-8000-0000000000aa';
  it('keeps people off with a clear message', () => {
    expect(publicFormFieldProblem({ type: 'user' }, {})).toMatch(/People fields can't be/);
  });
  it('needs a view for a link field', () => {
    expect(publicFormFieldProblem({ type: 'link' }, {})).toMatch(/Choose the view/);
    expect(publicFormFieldProblem({ type: 'link' }, { viewIdForRecordSelection: null })).toMatch(
      /Choose the view/
    );
    expect(publicFormFieldProblem({ type: 'link' }, { viewIdForRecordSelection: view })).toBeNull();
  });
  it('keeps fields editors cannot edit off, unless they allow forms', () => {
    const creators = { edit: { level: 'creators' } };
    expect(publicFormFieldProblem({ type: 'number', permissions: creators }, {})).toMatch(
      /Allow it to be filled through forms/
    );
    expect(
      publicFormFieldProblem({ type: 'number', permissions: { ...creators, allowForms: true } }, {})
    ).toBeNull();
    expect(publicFormFieldProblem({ type: 'number', permissions: {} }, {})).toBeNull();
    expect(publicFormFieldProblem({ type: 'formula' }, {})).not.toBeNull();
  });
});

describe('formLinkRecordsQuerySchema', () => {
  it('pages at most MAX_FORM_LINK_PAGE records and takes nothing else', () => {
    expect(formLinkRecordsQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(formLinkRecordsQuerySchema.safeParse({ limit: MAX_FORM_LINK_PAGE + 1 }).success).toBe(
      false
    );
    expect(formLinkRecordsQuerySchema.safeParse({ offset: 10_001 }).success).toBe(false);
    expect(formLinkRecordsQuerySchema.safeParse({ fields: 'x' }).success).toBe(false);
    expect(formLinkRecordsQuerySchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('formSubmissionSchema', () => {
  const ok = { submissionId: ids.name, fields: { [ids.age]: 3 } };
  it('takes the answers, the idempotency key and a CAPTCHA token', () => {
    expect(formSubmissionSchema.safeParse(ok).success).toBe(true);
    expect(formSubmissionSchema.safeParse({ ...ok, captchaToken: 'x' }).success).toBe(true);
  });

  it('refuses anything else: record ids, createdBy, non-field keys (H4)', () => {
    for (const extra of [{ id: ids.age }, { createdBy: ids.age }, { records: [] }]) {
      expect(formSubmissionSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    }
    for (const key of ['createdBy', 'id', '__proto__x']) {
      expect(formSubmissionSchema.safeParse({ ...ok, fields: { [key]: 'x' } }).success).toBe(false);
    }
    expect(formSubmissionSchema.safeParse({ fields: {} }).success).toBe(false);
  });
});

describe('createFormUploadSchema', () => {
  it('caps the size', () => {
    const base = { fieldId: ids.name, filename: 'a.txt', type: 'text/plain' };
    expect(createFormUploadSchema.safeParse({ ...base, size: 1 }).success).toBe(true);
    expect(
      createFormUploadSchema.safeParse({ ...base, size: MAX_FORM_UPLOAD_BYTES + 1 }).success
    ).toBe(false);
  });
});

describe('prefillAnswers', () => {
  it('prefills fields that allow it, by name or id, coerced through the registry', () => {
    const params = new URLSearchParams(
      `prefill_Name=Ada&prefill_Kind=bug&prefill_${ids.age}=42&prefill_Secret=x&prefill_Nope=1`
    );
    const { values, hidden } = prefillAnswers(params, entries, fields);
    expect(values).toEqual({ [ids.name]: 'Ada', [ids.kind]: 'bug', [ids.age]: 42 });
    expect(hidden.size).toBe(0);
  });

  it('drops unreadable values and hides only prefilled fields', () => {
    const params = new URLSearchParams(
      'prefill_Age=lots&prefill_Kind=Idea&hide_Kind=true&hide_Age=true&hide_Name=true'
    );
    const { values, hidden } = prefillAnswers(params, entries, fields);
    expect(values).toEqual({ [ids.kind]: 'idea' });
    expect([...hidden]).toEqual([ids.kind]);
  });
});
