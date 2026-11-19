import { mapTokens, type PathKey, parsePathSegments, TemplateError } from './template.js';

/**
 * The step tree of an automation: its actions are a list of steps, and two kinds of step hold
 * lists of their own: an If / Otherwise branch (`then` and `otherwise`) and a Repeat for each
 * group (`actions`, run once per item). Pure helpers over that tree, shared by the schema, the
 * run engine and the builder.
 *
 * A step's **address** is how tokens name it: its 1-based number in the top-level list, then
 * for each list it sits in, the list's name and its number there: `[2, 'then', 1]`, written
 * `2.then.1` and used as `{{steps.2.then.1.record.id}}`. Moving a step inside one list never
 * changes the address of a step outside that list.
 */

export const STEP_LISTS = ['then', 'otherwise', 'actions'] as const;
export type StepListName = (typeof STEP_LISTS)[number];

/** `[2, 'then', 1]`: a step's number in each list down from the top. */
export type StepAddress = readonly (number | StepListName)[];

/** A step as the tree helpers see it: its type, and its lists when it is a group. */
export interface StepLike {
  type: string;
  then?: readonly StepLike[] | undefined;
  otherwise?: readonly StepLike[] | undefined;
  actions?: readonly StepLike[] | undefined;
}

/** The lists a step holds: a branch's `then` and `otherwise`, a repeat's `actions`. */
export function stepListNames(type: unknown): readonly StepListName[] {
  if (type === 'branch') return ['then', 'otherwise'];
  if (type === 'repeat') return ['actions'];
  return [];
}

export const isStepGroup = (type: unknown) => stepListNames(type).length > 0;

/** The steps of one of a step's lists (none when it isn't a group, or the list is missing). */
export function stepList(step: unknown, name: StepListName): readonly unknown[] {
  if (!step || typeof step !== 'object') return [];
  if (!stepListNames((step as { type?: unknown }).type).includes(name)) return [];
  const list = (step as Record<string, unknown>)[name];
  return Array.isArray(list) ? list : [];
}

export interface VisitedStep {
  step: unknown;
  address: StepAddress;
  /** Where it sits in the actions as JSON (0-based): `[1, 'then', 0]`. */
  path: (string | number)[];
  /** 1 for a top-level step, 2 inside a group, 3 inside a group inside a group. */
  depth: number;
}

/** Every step of the tree, parents before their lists' steps (in run order). */
export function walkSteps(actions: readonly unknown[]): VisitedStep[] {
  const out: VisitedStep[] = [];
  const visit = (
    list: readonly unknown[],
    address: StepAddress,
    path: (string | number)[],
    depth: number
  ) => {
    list.forEach((step, i) => {
      const here: VisitedStep = {
        step,
        address: [...address, i + 1],
        path: [...path, i],
        depth,
      };
      out.push(here);
      const type = (step as { type?: unknown } | null)?.type;
      for (const name of stepListNames(type)) {
        visit(stepList(step, name), [...here.address, name], [...here.path, name], depth + 1);
      }
    });
  };
  visit(actions, [], [], 1);
  return out;
}

/** How many steps the tree holds, groups and the steps inside them alike. */
export const countSteps = (actions: readonly unknown[]) => walkSteps(actions).length;

/** `2.then.1`: the address as tokens write it. */
export const stepAddressText = (address: StepAddress) => address.join('.');

/** The step at an address, or undefined. */
export function stepAt(actions: readonly unknown[], address: StepAddress): unknown {
  let list: readonly unknown[] = actions;
  let step: unknown;
  for (let i = 0; i < address.length; i += 2) {
    const n = address[i];
    if (typeof n !== 'number' || n < 1 || n > list.length) return undefined;
    step = list[n - 1];
    const name = address[i + 1];
    if (name === undefined) return step;
    if (typeof name !== 'string' || !stepListNames((step as StepLike)?.type).includes(name)) {
      return undefined;
    }
    list = stepList(step, name);
  }
  return step;
}

/**
 * The step a token path names (`steps.2.then.1.record` → `[2, 'then', 1]`), following the
 * tree: a list name only counts after a group that has that list. Null when the path doesn't
 * start with `steps.<number>`.
 */
export function tokenStepAddress(
  actions: readonly unknown[],
  path: readonly PathKey[]
): (number | StepListName)[] | null {
  const [root, first] = path;
  if (root !== 'steps' || typeof first !== 'number') return null;
  const address: (number | StepListName)[] = [first];
  let step = actions[first - 1];
  for (let i = 2; i + 1 < path.length; i += 2) {
    const name = path[i];
    const n = path[i + 1];
    const type = (step as StepLike | undefined)?.type;
    if (typeof n !== 'number' || !stepListNames(type).includes(name as StepListName)) break;
    address.push(name as StepListName, n);
    step = stepList(step, name as StepListName)[n - 1];
  }
  return address;
}

/**
 * Why a token of the step at `at` can't point at `path`, or null when it can. A step may use
 * the trigger, the groups it sits in (a repeat's current item, a branch's path), the steps
 * before it in its own list and in the lists around it, and what ran inside an earlier If /
 * Otherwise (empty when that path didn't run). The steps inside a repeat are only for the
 * steps after them in the same repeat: after it, `{{steps.N.count}}` and `{{steps.N.items}}`.
 */
export function stepTokenProblem(
  actions: readonly unknown[],
  path: readonly PathKey[],
  at: StepAddress | null
): string | null {
  if (at === null) return "Tokens can't be used in the trigger.";
  if (path[0] === 'trigger') return null;
  const label = `Step ${stepAddressText(at)}`;
  const before = `${label} can only use the steps before it.`;
  const target = tokenStepAddress(actions, path);
  if (!target || (target[0] as number) < 1) return before;
  let k = 0;
  while (k < target.length && k < at.length && target[k] === at[k]) k++;
  // A group around the step: its item, index or path.
  if (k === target.length && k < at.length) return null;
  // The step itself, or a step inside it.
  if (k === at.length) return before;
  // Another path of the same branch.
  if (k % 2 === 1) return before;
  if ((target[k] as number) > (at[k] as number)) return before;
  if (stepAt(actions, target) === undefined) {
    return `${label} uses step ${stepAddressText(target)}, which doesn't exist.`;
  }
  if (target.slice(k + 1).includes('actions')) {
    return `${label} uses a step inside a Repeat for each; only the steps after it in the same group can.`;
  }
  return null;
}

/**
 * Rewrites the tokens that point at the steps of one list (`list`: its address, `[]` for the
 * top level, `[2, 'then']` for step 2's Then) after the list changed: `renumber` gives a step's
 * new number by its old one. Only those numbers change; everything else is left as written,
 * and a script's code is never touched (only its input variables hold tokens).
 */
export function renumberStepTokens<T>(
  value: T,
  list: StepAddress,
  renumber: (n: number) => number
): T {
  const at = list.length + 1;
  const token = (inner: string) => {
    let segments: ReturnType<typeof parsePathSegments>;
    try {
      segments = parsePathSegments(inner);
    } catch (err) {
      if (err instanceof TemplateError) return inner;
      throw err;
    }
    const keys = segments.map((x) => x.key);
    if (keys[0] !== 'steps' || list.some((k, i) => keys[i + 1] !== k)) return inner;
    const n = keys[at];
    const segment = segments[at];
    if (typeof n !== 'number' || !segment) return inner;
    const next = renumber(n);
    if (next === n) return inner;
    const raw = inner.slice(segment.start, segment.end);
    const written = raw.trimStart().startsWith('[') ? `[${next}]` : `.${next}`;
    return inner.slice(0, segment.start) + written + inner.slice(segment.end);
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mapTokens(v, token);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const script = (v as { type?: unknown }).type === 'runScript';
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, script && k === 'script' ? x : walk(x)])
      );
    }
    return v;
  };
  return walk(value) as T;
}
