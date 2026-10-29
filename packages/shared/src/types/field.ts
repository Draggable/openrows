import type { FieldType } from '../constants/index.js';

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  tableId: string;
  order: number;
  isPrimary: boolean;
  config: FieldConfig;
  createdAt: Date;
  updatedAt: Date;
}

/** Configuration varies by field type */
export type FieldConfig =
  | TextFieldConfig
  | NumberFieldConfig
  | DateFieldConfig
  | CheckboxFieldConfig
  | SelectFieldConfig
  | LinkFieldConfig
  | FormulaFieldConfig
  | RollupFieldConfig
  | LookupFieldConfig
  | AttachmentFieldConfig
  | BaseFieldConfig;

export interface BaseFieldConfig {
  /** Default value for new records */
  defaultValue?: unknown;
}

export interface TextFieldConfig extends BaseFieldConfig {
  /** Enable rich text editing */
  richText?: boolean;
}

export interface NumberFieldConfig extends BaseFieldConfig {
  /** Number of decimal places */
  precision?: number;
  /** Format as currency, percent, etc. */
  format?: 'number' | 'currency' | 'percent';
  /** Currency code if format is currency */
  currencyCode?: string;
}

export interface DateFieldConfig extends BaseFieldConfig {
  /** Include time in the date */
  includeTime?: boolean;
  /** Date format string */
  dateFormat?: string;
  /** Time format string */
  timeFormat?: string;
}

export interface CheckboxFieldConfig extends BaseFieldConfig {
  /** Icon to show for checked state */
  checkedIcon?: string;
}

export interface SelectFieldConfig extends BaseFieldConfig {
  /** Available options */
  options: SelectOption[];
}

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface LinkFieldConfig extends BaseFieldConfig {
  /** ID of the linked table */
  linkedTableId: string;
  /** ID of the inverse link field in the linked table */
  inverseLinkFieldId?: string;
  /** Relationship type */
  relationship: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

export interface FormulaFieldConfig extends BaseFieldConfig {
  /** Formula expression */
  formula: string;
  /** Result type of the formula */
  resultType: 'text' | 'number' | 'date' | 'boolean';
}

export interface RollupFieldConfig extends BaseFieldConfig {
  /** ID of the link field to roll up from */
  linkFieldId: string;
  /** ID of the field to aggregate in the linked table */
  rollupFieldId: string;
  /** Aggregation function */
  aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'counta' | 'countall';
}

export interface LookupFieldConfig extends BaseFieldConfig {
  /** ID of the link field to look up from */
  linkFieldId: string;
  /** ID of the field to look up in the linked table */
  lookupFieldId: string;
}

export interface AttachmentFieldConfig extends BaseFieldConfig {
  /** Allowed file types (MIME types or extensions) */
  allowedTypes?: string[];
  /** Maximum file size in bytes */
  maxSize?: number;
}
