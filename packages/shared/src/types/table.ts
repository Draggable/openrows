// Views are typed by the Zod schemas in schemas/view.ts (`ViewMeta`, `ViewConfig`).
export interface Table {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  baseId: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}
