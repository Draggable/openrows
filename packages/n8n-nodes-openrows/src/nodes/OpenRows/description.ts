import type { INodeProperties } from 'n8n-workflow';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** The base picker: the token's bases from `GET /api/v1/meta/bases`, or an id. */
export const baseLocator: INodeProperties = {
  displayName: 'Base',
  name: 'base',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      typeOptions: { searchListMethod: 'searchBases', searchable: true },
    },
    {
      displayName: 'ID',
      name: 'id',
      type: 'string',
      placeholder: '0195f0c2-…',
      validation: [{ type: 'regex', properties: { regex: UUID, errorMessage: 'Not a base ID' } }],
    },
  ],
};

/** The table picker: the base's tables, or an id or exact name. */
export const tableLocator: INodeProperties = {
  displayName: 'Table',
  name: 'table',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  typeOptions: { loadOptionsDependsOn: ['base.value'] },
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      typeOptions: { searchListMethod: 'searchTables', searchable: true },
    },
    {
      displayName: 'ID or Name',
      name: 'id',
      type: 'string',
      placeholder: 'Tasks',
    },
  ],
};

const show = (operation: string[]) => ({ show: { resource: ['record'], operation } });

export const recordProperties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    options: [{ name: 'Record', value: 'record' }],
    default: 'record',
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['record'] } },
    options: [
      {
        name: 'Create',
        value: 'create',
        action: 'Create a record',
        description: 'Create a record',
      },
      {
        name: 'Create or Update',
        value: 'upsert',
        action: 'Create or update a record',
        description: 'Update the record whose matching fields are equal, or create one',
      },
      {
        name: 'Delete',
        value: 'delete',
        action: 'Delete a record',
        description: 'Move a record to the trash',
      },
      { name: 'Get', value: 'get', action: 'Get a record', description: 'Get a record by ID' },
      {
        name: 'Get Many',
        value: 'getAll',
        action: 'Get many records',
        description: 'List records, filtered and sorted',
      },
      {
        name: 'Search',
        value: 'search',
        action: 'Search records',
        description: 'Find records whose text fields contain some text',
      },
      {
        name: 'Update',
        value: 'update',
        action: 'Update a record',
        description: 'Update a record',
      },
    ],
    default: 'getAll',
  },
  { ...baseLocator, displayOptions: { show: { resource: ['record'] } } },
  { ...tableLocator, displayOptions: { show: { resource: ['record'] } } },
  {
    displayName: 'Record ID',
    name: 'recordId',
    type: 'string',
    default: '',
    required: true,
    placeholder: '0195f0c2-…',
    displayOptions: show(['get', 'update', 'delete']),
  },
  {
    displayName: 'Fields',
    name: 'columns',
    type: 'resourceMapper',
    noDataExpression: true,
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    typeOptions: {
      loadOptionsDependsOn: ['table.value', 'base.value'],
      resourceMapper: {
        resourceMapperMethod: 'getColumns',
        mode: 'add',
        fieldWords: { singular: 'field', plural: 'fields' },
        addAllFields: true,
        multiKeyMatch: false,
        supportAutoMap: true,
      },
    },
    displayOptions: show(['create', 'update']),
  },
  {
    displayName: 'Fields',
    name: 'columns',
    type: 'resourceMapper',
    noDataExpression: true,
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    typeOptions: {
      loadOptionsDependsOn: ['table.value', 'base.value'],
      resourceMapper: {
        resourceMapperMethod: 'getColumnsWithMatch',
        mode: 'upsert',
        fieldWords: { singular: 'field', plural: 'fields' },
        addAllFields: true,
        multiKeyMatch: true,
        supportAutoMap: true,
        matchingFieldsLabels: {
          title: 'Fields to Match On',
          description: 'Up to 3 fields; a record whose values are all equal is updated',
        },
      },
    },
    displayOptions: show(['upsert']),
  },
  {
    displayName: 'Search Text',
    name: 'searchText',
    type: 'string',
    default: '',
    required: true,
    description: 'Text to find, ignoring case',
    displayOptions: show(['search']),
  },
  {
    displayName: 'Search In Field Names or IDs',
    name: 'searchFields',
    type: 'multiOptions',
    default: [],
    typeOptions: { loadOptionsMethod: 'getSearchFields', loadOptionsDependsOn: ['table.value'] },
    description:
      'Fields to look in (default: every text field). Choose from the list, or specify names using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    displayOptions: show(['search']),
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: show(['getAll', 'search']),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    description: 'Max number of results to return',
    displayOptions: {
      show: { resource: ['record'], operation: ['getAll', 'search'], returnAll: [false] },
    },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: show(['getAll', 'search']),
    options: [
      {
        displayName: 'Filter By Formula',
        name: 'filterByFormula',
        type: 'string',
        default: '',
        placeholder: "AND({Status} = 'Done', {Estimate} > 3)",
        description:
          "Only records for which the formula is true (Airtable's syntax: AND, OR, NOT, comparisons, FIND/SEARCH, BLANK(), TODAY(), IS_BEFORE/IS_AFTER)",
      },
      {
        displayName: 'Output Field Names or IDs',
        name: 'fields',
        type: 'multiOptions',
        default: [],
        typeOptions: { loadOptionsMethod: 'getFields', loadOptionsDependsOn: ['table.value'] },
        description:
          'Only these fields. Choose from the list, or specify names using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Sort',
        name: 'sort',
        type: 'fixedCollection',
        placeholder: 'Add sort rule',
        default: {},
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: 'Rule',
            name: 'rule',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'field',
                type: 'options',
                default: '',
                typeOptions: { loadOptionsMethod: 'getFields' },
                description:
                  'Choose from the list, or specify a name using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              {
                displayName: 'Direction',
                name: 'direction',
                type: 'options',
                options: [
                  { name: 'Ascending', value: 'asc' },
                  { name: 'Descending', value: 'desc' },
                ],
                default: 'asc',
              },
            ],
          },
        ],
      },
      {
        displayName: 'View Name or ID',
        name: 'view',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'getViews', loadOptionsDependsOn: ['table.value'] },
        description:
          'Only the records of this view, in its order. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: show(['create', 'update', 'upsert']),
    options: [
      {
        displayName: 'Typecast',
        name: 'typecast',
        type: 'boolean',
        default: false,
        description:
          'Whether to read values as text when they need it: new select options are added, linked records found by name',
      },
    ],
  },
];
