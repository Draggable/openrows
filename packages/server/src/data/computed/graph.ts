import {
  computedSourceOf,
  type FormulaNode,
  hasFormula,
  linkOptionsSchema,
  parseStoredFormula,
} from '@openrows/shared';

/**
 * The field dependency graph of a base, derived from the fields' metadata: a lookup,
 * rollup or count field depends on the link field of its table it reads through, and (lookup,
 * rollup) on the field of the linked table it reads; a formula field depends on the fields
 * of its table its formula references. Pure: the engine (engine.ts) loads the nodes from
 * RLS-protected metadata in the request's transaction.
 */

/** A live field of the base, as the graph sees it. */
export interface GraphField {
  id: string;
  tableId: string;
  type: string;
  options: unknown;
}

/** A computed field's edges, resolved against the base's live fields. */
export interface ComputedNode {
  field: GraphField;
  /** The link field of the same table. */
  link: GraphField;
  /** The table the link points at. */
  linkedTableId: string;
  /** The field of the linked table it reads (`null` for count). */
  source: GraphField | null;
}

/** A formula field's edges: the live fields of its table it references. */
export interface FormulaGraphNode {
  field: GraphField;
  ast: FormulaNode;
  deps: GraphField[];
  /** It calls LAST_MODIFIED_TIME(): any change to the record makes it stale. */
  readsAnyChange: boolean;
  /**
   * It calls NOW() or TODAY() (`clock`), and SET_TIMEZONE (`zoned`): the worker refreshes it
   * hourly, and zoned ones at the half and three-quarter hours too.
   */
  clock: { zoned: boolean } | null;
}

/** The parsed formula of a formula field's options, or `null` (empty or unreadable). */
export function formulaAstOf(f: Pick<GraphField, 'type' | 'options'>): FormulaNode | null {
  if (!hasFormula(f.type)) return null;
  const text = (f.options as { formula?: unknown } | null)?.formula;
  if (typeof text !== 'string' || text.trim() === '') return null;
  const parsed = parseStoredFormula(text);
  return parsed.ok ? parsed.ast : null;
}

/** Every field id and function name a formula AST mentions. */
export function formulaRefs(ast: FormulaNode): { fieldIds: string[]; functions: Set<string> } {
  const fieldIds = new Set<string>();
  const functions = new Set<string>();
  const walk = (n: FormulaNode) => {
    switch (n.type) {
      case 'field':
        fieldIds.add(n.fieldId);
        break;
      case 'unary':
        walk(n.operand);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      case 'call':
        functions.add(n.name);
        for (const a of n.args) walk(a);
        break;
    }
  };
  walk(ast);
  return { fieldIds: [...fieldIds], functions };
}

function resolveFormula(
  f: GraphField,
  byId: ReadonlyMap<string, GraphField>
): FormulaGraphNode | null {
  const ast = formulaAstOf(f);
  if (!ast) return null;
  const refs = formulaRefs(ast);
  const deps = refs.fieldIds.flatMap((id) => {
    const dep = byId.get(id);
    return dep && dep.tableId === f.tableId ? [dep] : [];
  });
  const clock =
    refs.functions.has('NOW') || refs.functions.has('TODAY')
      ? { zoned: refs.functions.has('SET_TIMEZONE') }
      : null;
  return {
    field: f,
    ast,
    deps,
    readsAnyChange: refs.functions.has('LAST_MODIFIED_TIME'),
    clock,
  };
}

/** The computed fields a field reads (lookup/rollup source, formula references). */
function computedDeps(
  id: string,
  nodeOf: (id: string) => ComputedNode | null,
  formulaOf: (id: string) => FormulaGraphNode | null
): string[] {
  const formula = formulaOf(id);
  if (formula) return formula.deps.map((d) => d.id);
  const node = nodeOf(id);
  return node?.source ? [node.source.id] : [];
}

/** Why a computed field's options don't resolve (422 on create or update). */
export interface ComputedProblem {
  path: string;
  message: string;
}

export class DependencyGraph {
  readonly byId: Map<string, GraphField>;
  /** Resolved computed fields; ones whose link or source is missing are left out. */
  readonly nodes = new Map<string, ComputedNode>();
  /** Formula fields with a readable formula. */
  readonly formulas = new Map<string, FormulaGraphNode>();
  /** Field id → the computed fields that read it (as their link or their source). */
  private readonly dependents = new Map<string, string[]>();

  constructor(readonly fields: readonly GraphField[]) {
    this.byId = new Map(fields.map((f) => [f.id, f]));
    for (const f of fields) {
      const formula = resolveFormula(f, this.byId);
      if (formula) {
        this.formulas.set(f.id, formula);
        for (const dep of formula.deps) this.addDependent(dep.id, f.id);
        continue;
      }
      const node = this.resolve(f);
      if (!node) continue;
      this.nodes.set(f.id, node);
      for (const dep of [node.link, node.source]) {
        if (dep) this.addDependent(dep.id, f.id);
      }
    }
  }

  private addDependent(fieldId: string, dependent: string) {
    const list = this.dependents.get(fieldId) ?? [];
    if (!list.includes(dependent)) list.push(dependent);
    this.dependents.set(fieldId, list);
  }

  /** Whether the field is computed by the engine (a resolved lookup/rollup/count or formula). */
  has(fieldId: string): boolean {
    return this.nodes.has(fieldId) || this.formulas.has(fieldId);
  }

  get size(): number {
    return this.nodes.size + this.formulas.size;
  }

  /** The node of a computed field, or `null` when its options don't resolve. */
  resolve(f: GraphField): ComputedNode | null {
    return resolveNode(f, this.byId).node;
  }

  /** The computed fields reading `fieldId` directly. */
  directDependents(fieldId: string): string[] {
    return this.dependents.get(fieldId) ?? [];
  }

  /**
   * Every computed field downstream of `fieldIds` (and those of `fieldIds` that are computed),
   * in recompute order.
   */
  downstream(fieldIds: Iterable<string>): string[] {
    const seen = new Set<string>();
    const visit = (id: string) => {
      for (const d of this.directDependents(id)) {
        if (seen.has(d)) continue;
        seen.add(d);
        visit(d);
      }
    };
    for (const id of fieldIds) {
      if (this.has(id)) seen.add(id);
      visit(id);
    }
    return this.order().filter((id) => seen.has(id));
  }

  /** Computed fields in dependency order (a field after every computed field it reads). */
  order(): string[] {
    const out: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string) => {
      if (state.get(id)) return;
      state.set(id, 'visiting');
      const deps = computedDeps(
        id,
        (x) => this.nodes.get(x) ?? null,
        (x) => this.formulas.get(x) ?? null
      );
      for (const dep of deps) if (this.has(dep)) visit(dep);
      state.set(id, 'done');
      out.push(id);
    };
    for (const id of [...this.nodes.keys(), ...this.formulas.keys()]) visit(id);
    return out;
  }

  /**
   * The cycle `candidate` would close (its field ids, from the candidate back to it), or `null`.
   * A computed field reading itself, or a computed field that (through any number of lookups,
   * rollups and formulas) reads the candidate, is a cycle.
   */
  cycleThrough(candidate: GraphField): string[] | null {
    const byId = new Map(this.byId);
    byId.set(candidate.id, candidate);
    const nodeOf = (id: string) => {
      const f = byId.get(id);
      return f ? resolveNode(f, byId).node : null;
    };
    const formulaOf = (id: string) => {
      const f = byId.get(id);
      return f ? resolveFormula(f, byId) : null;
    };
    const path: string[] = [];
    const onPath = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): boolean => {
      if (onPath.has(id)) return true;
      if (done.has(id)) return false;
      const deps = computedDeps(id, nodeOf, formulaOf);
      if (!deps.length) return false;
      path.push(id);
      onPath.add(id);
      for (const dep of deps) if (visit(dep)) return true;
      path.pop();
      onPath.delete(id);
      done.add(id);
      return false;
    };
    return visit(candidate.id) ? [...path, candidate.id] : null;
  }
}

/** Resolves a computed field's options against the base's fields, with the problem if any. */
export function resolveNode(
  f: GraphField,
  byId: ReadonlyMap<string, GraphField>
): { node: ComputedNode | null; problem?: ComputedProblem } {
  const src = computedSourceOf(f.type, f.options);
  if (!src) return { node: null };
  const fail = (path: string, message: string) => ({ node: null, problem: { path, message } });
  const link = src.linkFieldId ? byId.get(src.linkFieldId) : undefined;
  if (!src.linkFieldId) return fail('options.recordLinkFieldId', 'Choose a link field.');
  if (!link || link.tableId !== f.tableId || link.type !== 'link') {
    return fail('options.recordLinkFieldId', 'Not a link field of this table.');
  }
  const linkedTableId = linkOptionsSchema.safeParse(link.options ?? {}).data?.linkedTableId;
  if (!linkedTableId) return fail('options.recordLinkFieldId', 'The link field links no table.');
  if (f.type === 'count') return { node: { field: f, link, linkedTableId, source: null } };
  if (!src.sourceFieldId) {
    return fail('options.fieldIdInLinkedTable', 'Choose a field of the linked table.');
  }
  const source = byId.get(src.sourceFieldId);
  if (!source || source.tableId !== linkedTableId) {
    return fail('options.fieldIdInLinkedTable', 'Not a field of the linked table.');
  }
  return { node: { field: f, link, linkedTableId, source } };
}
