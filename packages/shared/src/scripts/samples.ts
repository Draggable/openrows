// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the samples are scripts' source, template literals included.
/**
 * Browser scripts: the examples the Scripts page offers for a new script. Each asks for
 * its table and fields, so it works on any base.
 */
export interface SampleScript {
  key: 'dedupe' | 'bulkUpdate' | 'report';
  name: string;
  description: string;
  code: string;
}

const lines = (...list: string[]) => `${list.join('\n')}\n`;

export const SAMPLE_SCRIPTS: readonly SampleScript[] = [
  {
    key: 'dedupe',
    name: 'Remove duplicates',
    description: 'Finds records with the same value in a field and deletes the extra copies.',
    code: lines(
      "const table = await input.tableAsync('Table to clean up');",
      "const field = await input.fieldAsync('Field that should be unique', table);",
      'const query = await table.selectRecordsAsync({ fields: [field] });',
      '',
      'const seen = new Set();',
      'const duplicates = [];',
      'for (const record of query.records) {',
      '  const key = record.getCellValueAsString(field).trim().toLowerCase();',
      '  if (!key) continue;',
      '  if (seen.has(key)) duplicates.push(record);',
      '  else seen.add(key);',
      '}',
      '',
      'output.markdown(`**${duplicates.length}** duplicate records in ${table.name}.`);',
      'if (duplicates.length > 0) {',
      '  output.table(',
      '    duplicates.map((r) => ({ Record: r.name, [field.name]: r.getCellValueAsString(field) }))',
      '  );',
      "  const choice = await input.buttonsAsync('Delete the duplicates?', [",
      "    { label: 'Delete', variant: 'danger' },",
      "    'Cancel',",
      '  ]);',
      "  if (choice === 'Delete') {",
      '    for (let i = 0; i < duplicates.length; i += 50) {',
      '      await table.deleteRecordsAsync(duplicates.slice(i, i + 50));',
      '    }',
      '    output.text(`Deleted ${duplicates.length} records.`);',
      '  }',
      '}'
    ),
  },
  {
    key: 'bulkUpdate',
    name: 'Find and replace',
    description: 'Replaces text in a field of every record, 50 records per update.',
    code: lines(
      "const table = await input.tableAsync('Table');",
      "const field = await input.fieldAsync('Text field to change', table);",
      "const find = await input.textAsync('Find');",
      "const replacement = await input.textAsync('Replace with');",
      'const query = await table.selectRecordsAsync({ fields: [field] });',
      '',
      'const updates = [];',
      'for (const record of query.records) {',
      '  const value = record.getCellValueAsString(field);',
      '  if (find && value.includes(find)) {',
      '    updates.push({ id: record.id, fields: { [field.id]: value.split(find).join(replacement) } });',
      '  }',
      '}',
      'for (let i = 0; i < updates.length; i += 50) {',
      '  await table.updateRecordsAsync(updates.slice(i, i + 50));',
      '}',
      'output.text(`Updated ${updates.length} records.`);'
    ),
  },
  {
    key: 'report',
    name: 'Summary report',
    description: 'Counts the records of a table by the values of a field.',
    code: lines(
      "const table = await input.tableAsync('Table');",
      "const field = await input.fieldAsync('Group by', table);",
      'const query = await table.selectRecordsAsync({ fields: [field] });',
      '',
      'const counts = new Map();',
      'for (const record of query.records) {',
      "  const key = record.getCellValueAsString(field) || '(empty)';",
      '  counts.set(key, (counts.get(key) ?? 0) + 1);',
      '}',
      '',
      'output.markdown(`## ${table.name} by ${field.name}`);',
      'output.table(',
      '  [...counts]',
      '    .sort((a, b) => b[1] - a[1])',
      '    .map(([value, count]) => ({ [field.name]: value, Records: count }))',
      ');',
      'output.text(`${query.records.length} records in total.`);'
    ),
  },
];
