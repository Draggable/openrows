import { z } from 'zod';

/**
 * Saved scripts: a base's scripts for the Scripts page, run in the browser's sandbox
 * (`packages/shared/src/scripts/`) with the runner's own permissions. Creators and owners write
 * them (`base:manage_scripts`); editors and up read and run them (`base:read_scripts`). Separate
 * from the run-script automation step, which runs on the server.
 */

/** Scripts per base. */
export const MAX_SCRIPTS_PER_BASE = 100;
export const MAX_SCRIPT_NAME_LENGTH = 100;
export const MAX_SCRIPT_DESCRIPTION_LENGTH = 500;
/** Characters of a script's code (100 KB). */
export const MAX_SCRIPT_CODE_LENGTH = 100_000;

const name = z.string().trim().min(1, 'Name the script.').max(MAX_SCRIPT_NAME_LENGTH);
const description = z.string().trim().max(MAX_SCRIPT_DESCRIPTION_LENGTH);
const code = z
  .string()
  .max(MAX_SCRIPT_CODE_LENGTH, `A script has at most ${MAX_SCRIPT_CODE_LENGTH} characters.`);

export const createScriptSchema = z
  .object({ name, description: description.default(''), code: code.default('') })
  .strict();

export const updateScriptSchema = z
  .object({ name: name.optional(), description: description.optional(), code: code.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

const at = z.iso.datetime({ offset: true });

export const ScriptSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  name: z.string(),
  description: z.string(),
  code: z.string(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: at,
  updatedAt: at,
});

/** `GET /api/bases/:baseId/scripts`: the base's scripts by name, and whether the caller edits. */
export const ScriptListSchema = z.object({
  scripts: z.array(ScriptSchema),
  canEdit: z.boolean(),
});

export type CreateScriptInput = z.input<typeof createScriptSchema>;
export type UpdateScriptInput = z.infer<typeof updateScriptSchema>;
export type Script = z.infer<typeof ScriptSchema>;
export type ScriptList = z.infer<typeof ScriptListSchema>;
