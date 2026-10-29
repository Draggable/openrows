import { defineTemplate } from '../define.js';

export const bugTracker = defineTemplate({
  slug: 'bug-tracker',
  name: 'Bug tracker',
  description: 'Report, triage and fix bugs, and see what each release fixed.',
  category: 'Engineering',
  icon: 'bug',
  color: '#B3261E',
  tables: [
    {
      key: 'bugs',
      name: 'Bugs',
      fields: [
        { key: 'summary', name: 'Summary', type: 'singleLineText' },
        {
          key: 'status',
          name: 'Status',
          type: 'singleSelect',
          choices: [
            ['Triage', 'slate'],
            ['Confirmed', 'blue'],
            ['In progress', 'amber'],
            ['Fixed', 'green'],
            ["Won't fix", 'red'],
          ],
        },
        {
          key: 'severity',
          name: 'Severity',
          type: 'singleSelect',
          choices: [
            ['Critical', 'red'],
            ['Major', 'brown'],
            ['Minor', 'blue'],
            ['Cosmetic', 'slate'],
          ],
        },
        {
          key: 'component',
          name: 'Component',
          type: 'singleSelect',
          choices: ['Web app', 'API', 'Mobile', 'Billing', 'Auth'],
        },
        { key: 'reported', name: 'Reported', type: 'date' },
        { key: 'reporter', name: 'Reporter email', type: 'email' },
        { key: 'steps', name: 'Steps to reproduce', type: 'longText' },
        {
          key: 'release',
          name: 'Fixed in',
          type: 'link',
          table: 'releases',
          single: true,
          inverse: { key: 'bugs', name: 'Bugs fixed' },
        },
        { key: 'number', name: 'ID', type: 'autoNumber' },
      ],
      views: [
        { name: 'Triage board', type: 'kanban', stack: 'status' },
        { name: 'All bugs', type: 'grid', sorts: [['reported', 'desc']] },
        { name: 'By severity', type: 'grid', groupBy: ['severity'] },
        { name: 'Report a bug', type: 'form' },
      ],
      records: [
        {
          summary: 'Checkout fails with a 500 for EUR cards',
          status: 'In progress',
          severity: 'Critical',
          component: 'Billing',
          reported: '2026-10-26',
          reporter: 'support@example.com',
          steps:
            '1. Pick the yearly plan\n2. Pay with a card issued in the EU\n3. See "Something went wrong"',
        },
        {
          summary: 'Password reset email lands in spam',
          status: 'Confirmed',
          severity: 'Major',
          component: 'Auth',
          reported: '2026-10-24',
          reporter: 'maya.chen@example.com',
        },
        {
          summary: 'Grid header misaligned on Safari 18',
          status: 'Fixed',
          severity: 'Minor',
          component: 'Web app',
          reported: '2026-10-12',
          reporter: 'qa@example.com',
          release: '2.4.1',
        },
        {
          summary: 'API returns 429 below the documented limit',
          status: 'Fixed',
          severity: 'Major',
          component: 'API',
          reported: '2026-10-09',
          reporter: 'dev@partner.example.com',
          release: '2.4.1',
        },
        {
          summary: 'Dark mode: tooltip text unreadable',
          status: 'Triage',
          severity: 'Cosmetic',
          component: 'Web app',
          reported: '2026-10-27',
          reporter: 'qa@example.com',
        },
        {
          summary: 'App crashes when rotating on Android 15',
          status: 'In progress',
          severity: 'Major',
          component: 'Mobile',
          reported: '2026-10-20',
          reporter: 'beta@example.com',
        },
        {
          summary: 'Invoice PDF shows the wrong VAT number',
          status: 'Fixed',
          severity: 'Major',
          component: 'Billing',
          reported: '2026-09-30',
          reporter: 'finance@example.com',
          release: '2.4.0',
        },
        {
          summary: 'Typo on the sign-up page',
          status: "Won't fix",
          severity: 'Cosmetic',
          component: 'Web app',
          reported: '2026-09-21',
          reporter: 'qa@example.com',
        },
      ],
    },
    {
      key: 'releases',
      name: 'Releases',
      fields: [
        { key: 'version', name: 'Version', type: 'singleLineText' },
        { key: 'date', name: 'Release date', type: 'date' },
        { key: 'notes', name: 'Release notes', type: 'longText' },
        { key: 'fixed', name: 'Bugs fixed count', type: 'count', link: 'bugs' },
      ],
      records: [
        { version: '2.4.0', date: '2026-10-05', notes: 'Billing fixes and faster exports.' },
        { version: '2.4.1', date: '2026-10-19', notes: 'API rate limit fix, Safari layout fix.' },
        { version: '2.5.0', date: '2026-11-09', notes: 'Planned: mobile stability.' },
      ],
    },
  ],
  automations: (ids) => [
    {
      name: 'Triage new bugs',
      description: 'Sets a new bug to Triage. Turn it on in Automations.',
      trigger: { type: 'recordCreated', tableId: ids.table('bugs') },
      actions: [
        {
          type: 'updateRecord',
          tableId: ids.table('bugs'),
          recordId: '{{trigger.record.id}}',
          fields: { [ids.field('bugs', 'status')]: 'Triage' },
        },
      ],
    },
  ],
  // The sample interface: a bug desk to share with people who shouldn't see the base.
  interfaces: (ids) => {
    const bugs = ids.table('bugs');
    const f = (key: string) => ids.field('bugs', key);
    const at = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
    return [
      {
        name: 'Bug desk',
        pages: [
          {
            name: 'Report a bug',
            config: {
              layout: 'form',
              tableId: bugs,
              elements: [
                {
                  id: 'intro',
                  type: 'text',
                  ...at(0, 0, 12, 2),
                  content:
                    '## Report a bug\nTell us what went wrong. The team triages new reports every day.',
                },
              ],
              form: {
                fields: [
                  { fieldId: f('summary'), label: 'What went wrong?', required: true },
                  { fieldId: f('severity'), label: '', required: true },
                  { fieldId: f('component'), label: '', required: false },
                  { fieldId: f('steps'), label: '', required: false },
                  { fieldId: f('reporter'), label: 'Your email', required: false },
                ],
                submitLabel: 'Report bug',
                successMessage: 'Thanks! The bug is in the triage queue.',
              },
            },
          },
          {
            name: 'Triage board',
            config: {
              layout: 'kanban',
              tableId: bugs,
              kanban: { stackFieldId: f('status'), cardFields: [f('severity'), f('component')] },
            },
          },
          {
            name: 'Open bugs',
            config: {
              layout: 'recordReview',
              tableId: bugs,
              filter: {
                conjunction: 'and',
                conditions: [
                  { fieldId: f('status'), operator: 'isNoneOf', value: ['Fixed', "Won't fix"] },
                ],
              },
              sorts: [{ fieldId: f('reported'), direction: 'desc' }],
              fields: [f('severity'), f('component')],
              elements: [
                {
                  id: 'component',
                  type: 'filter',
                  ...at(0, 0, 6, 2),
                  fieldId: f('component'),
                  label: 'Component',
                },
                {
                  id: 'status',
                  type: 'field',
                  ...at(0, 2, 6, 2),
                  fieldId: f('status'),
                  editable: true,
                },
                {
                  id: 'severity',
                  type: 'field',
                  ...at(6, 2, 6, 2),
                  fieldId: f('severity'),
                  editable: true,
                },
                {
                  id: 'steps',
                  type: 'field',
                  ...at(0, 4, 12, 4),
                  fieldId: f('steps'),
                  editable: false,
                },
              ],
            },
          },
          {
            name: 'Overview',
            config: {
              layout: 'dashboard',
              tableId: bugs,
              elements: [
                {
                  id: 'open',
                  type: 'number',
                  ...at(0, 0, 4, 2),
                  label: 'Open bugs',
                  tableId: bugs,
                  filter: {
                    conjunction: 'and',
                    conditions: [
                      { fieldId: f('status'), operator: 'isNoneOf', value: ['Fixed', "Won't fix"] },
                    ],
                  },
                  fn: 'count',
                },
                {
                  id: 'by-status',
                  type: 'chart',
                  ...at(0, 2, 6, 6),
                  label: 'Bugs by status',
                  tableId: bugs,
                  chart: 'bar',
                  groupFieldId: f('status'),
                },
                {
                  id: 'by-severity',
                  type: 'chart',
                  ...at(6, 2, 6, 6),
                  label: 'Bugs by severity',
                  tableId: bugs,
                  chart: 'donut',
                  groupFieldId: f('severity'),
                },
              ],
            },
          },
        ],
      },
    ];
  },
});
