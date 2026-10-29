export interface Record {
  id: string;
  tableId: string;
  /** Field values keyed by field ID */
  fields: RecordFields;
  order: number;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
}

/** Record field values - keys are field IDs, values depend on field type */
export type RecordFields = {
  [fieldId: string]: FieldValue;
};

/** Possible field value types */
export type FieldValue =
  | string
  | number
  | boolean
  | Date
  | string[] // multi-select or link
  | Attachment[]
  | null
  | undefined;

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  uploadedAt: Date;
}

export interface RecordComment {
  id: string;
  recordId: string;
  userId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}
