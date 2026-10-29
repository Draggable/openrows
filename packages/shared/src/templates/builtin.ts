import { bugTracker } from './builtin/bug-tracker.js';
import { contentCalendar } from './builtin/content-calendar.js';
import { crm } from './builtin/crm.js';
import { customerFeedback } from './builtin/customer-feedback.js';
import { eventPlanning } from './builtin/event-planning.js';
import { hiringPipeline } from './builtin/hiring-pipeline.js';
import { inventory } from './builtin/inventory.js';
import { okrs } from './builtin/okrs.js';
import { productRoadmap } from './builtin/product-roadmap.js';
import { projectTracker } from './builtin/project-tracker.js';
import type { Template } from './format.js';

/** The built-in templates, in the gallery's order. */
export const BUILT_IN_TEMPLATES: readonly Template[] = [
  productRoadmap,
  crm,
  projectTracker,
  contentCalendar,
  bugTracker,
  eventPlanning,
  inventory,
  hiringPipeline,
  okrs,
  customerFeedback,
];

export function findTemplate(slug: string): Template | null {
  return BUILT_IN_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
