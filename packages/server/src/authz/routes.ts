import {
  ACTION_SCOPES,
  type Action,
  type ActionOn,
  ADMIN_REAUTH_MINUTES,
  type EndpointDef,
  type EndpointRequest,
  type EndpointResult,
  type ResourceKind,
  type TokenScope,
} from '@openrows/shared';
import type { Context, Env, Handler, Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  hasBearer,
  type OptionalSessionEnv,
  type SessionEnv,
  type SessionMiddleware,
} from '../auth/middleware.js';
import type { Database } from '../db/index.js';
import type { AppEnv } from '../lib/context.js';
import { AppError } from '../lib/errors.js';
import { readJson } from '../lib/validate.js';
import { type ResourceEnv, withResource } from './middleware.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call a route. Every route declares one; nothing else adds routes to the app. `token`
 * is the scope a personal access token needs; null: a signed-in session only.
 */
export type Access =
  /** Anyone, signed in or not (health checks, the sign-in flow). */
  | { kind: 'public' }
  /** Any signed-in user; the handler only touches the user's own data. */
  | { kind: 'session'; token: TokenScope | null }
  /**
   * A personal access token only, of any scope (never the cookie): the remote MCP endpoint
   * , whose every call goes back through the authorized routes with the same token.
   */
  | { kind: 'token' }
  /**
   * A system admin's signed-in session (the hosted ops console): 404 for everyone
   * else (anonymous, tokens, impersonations, every tenant role), 403 REAUTHENTICATION_REQUIRED
   * without a sign-in in the last ADMIN_REAUTH_MINUTES.
   */
  | { kind: 'admin' }
  /** `authorize(principal, action, resource)` through `withResource`. */
  | {
      kind: 'resource';
      resource: ResourceKind;
      action: Action;
      param: string;
      token: TokenScope | null;
    };

export interface RouteEntry {
  method: Method;
  path: string;
  access: Access;
  /** The shared endpoint contract, for JSON API routes registered with `endpoint`. */
  contract?: EndpointDef;
}

/** A contract route's handler: gets the validated request, returns the response data. */
export type EndpointHandler<E extends EndpointDef, V extends Env> = (
  c: Context<V>,
  request: EndpointRequest<E>
) => EndpointResult<E> | Promise<EndpointResult<E>>;

/** The resource access rule of `resource` and `endpoint`. */
export interface ResourceAccess<K extends ResourceKind> {
  resource: K;
  action: ActionOn<K>;
  param?: string;
  /**
   * The token scope this route needs instead of the action's (`ACTION_SCOPES`), e.g. record data
   * behind a `base:read` route; null keeps it to signed-in sessions.
   */
  token?: TokenScope | null;
}

/** A session route personal access tokens may call too, with `token` among their scopes. */
export interface SessionAccess {
  token: TokenScope;
}

/** 403 for a personal access token without `scope` (null: no token at all) on a session route. */
function tokenGate(scope: TokenScope | null): MiddlewareHandler<SessionEnv> {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const { token } = c.var.principal;
    if (token && (scope === null || !token.scopes.includes(scope))) {
      throw new AppError('FORBIDDEN', {
        detail:
          scope === null
            ? "This needs a signed-in session; personal access tokens can't use it."
            : `This personal access token needs the ${scope} scope.`,
      });
    }
    await next();
  });
}

/**
 * Wraps a contract handler: path parameters (404 when a checked one is malformed), query (422)
 * and body (400/422) are parsed with the contract's schemas, and the result goes through the
 * response schema, so the server can't answer something the client won't accept.
 */
function contractHandler<E extends EndpointDef, V extends Env>(
  contract: E,
  handler: EndpointHandler<E, V>
): Handler<V> {
  return async (c) => {
    const params: Record<string, string> = c.req.param();
    for (const [name, check] of Object.entries(contract.params ?? {})) {
      if (check && !check.safeParse(params[name]).success) {
        throw new AppError('NOT_FOUND', { detail: `No such ${name.replace(/Id$/, '')}.` });
      }
    }
    const query = contract.query
      ? contract.query.parse(contract.queryArrays ? c.req.queries() : c.req.query())
      : undefined;
    const body = contract.body ? await readJson(c, contract.body) : undefined;
    const result = await handler(c, { params, query, body } as EndpointRequest<E>);
    if (contract.response === null) return c.body(null, 204);
    return c.json(contract.response.parse(result), contract.status as 200 | 201);
  };
}

/**
 * The ops console's gate, after `optionalSession`: anything but a system admin's own
 * session is 404, so the console doesn't reveal that it exists. `users.is_system_admin` is read
 * afresh on every request (the session joins the user).
 */
const requireSystemAdmin = createMiddleware<OptionalSessionEnv>(async (c, next) => {
  const { principal } = c.var;
  if (
    hasBearer(c) ||
    !principal ||
    principal.token ||
    principal.impersonation ||
    !principal.user.isSystemAdmin
  ) {
    throw new AppError('NOT_FOUND');
  }
  const signedInAt = principal.session.authenticatedAt?.getTime() ?? 0;
  if (signedInAt + ADMIN_REAUTH_MINUTES * 60_000 <= Date.now()) {
    throw new AppError('REAUTHENTICATION_REQUIRED', {
      detail: `The ops console needs a sign-in within the last ${ADMIN_REAUTH_MINUTES} minutes.`,
    });
  }
  await next();
});

/** 401 without `Authorization: Bearer …`, saying a personal access token is needed. */
const requireBearer = createMiddleware<SessionEnv>(async (c, next) => {
  if (!hasBearer(c)) {
    c.header('WWW-Authenticate', 'Bearer');
    throw new AppError('UNAUTHENTICATED', {
      detail: 'This needs a personal access token: Authorization: Bearer or_pat_…',
    });
  }
  await next();
});

// Hono's route-adding overloads don't accept a computed method and spread handlers.
type AddRoute = (method: Method, path: string, ...handlers: MiddlewareHandler[]) => unknown;

/**
 * The route registry. Routes are added only through `public`, `session` and `resource`, so each
 * one states its access rule. `unregisteredRoutes` (checked by createApp at startup and by
 * tests) catches any route added to the app another way, and the cross-tenant matrix
 * (test/integration/authz-matrix.test.ts) calls every entry as every kind of caller.
 */
export class RouteRegistry {
  readonly entries: RouteEntry[] = [];
  readonly #add: AddRoute;

  constructor(
    readonly app: Hono<AppEnv>,
    private readonly deps: { db: Database; session: SessionMiddleware }
  ) {
    this.#add = app.on.bind(app) as unknown as AddRoute;
  }

  #register(
    method: Method,
    path: string,
    access: Access,
    handlers: unknown[],
    contract?: EndpointDef
  ) {
    if (this.entries.some((e) => e.method === method && e.path === path)) {
      throw new Error(`route ${method} ${path} is registered twice`);
    }
    this.entries.push({ method, path, access, ...(contract ? { contract } : {}) });
    this.#add(method, path, ...(handlers as MiddlewareHandler[]));
  }

  /** Middleware for every method under `path` (rate limits); adds no route. */
  use(path: string, middleware: MiddlewareHandler<AppEnv>): void {
    this.app.use(path, middleware);
  }

  public(
    method: Method,
    path: string,
    ...handlers: [...MiddlewareHandler<AppEnv>[], Handler<AppEnv>]
  ) {
    this.#register(method, path, { kind: 'public' }, handlers);
  }

  /** Session-only unless `access.token` lets personal access tokens with that scope in. */
  session(
    method: Method,
    path: string,
    handler: Handler<SessionEnv>,
    contract?: EndpointDef,
    access?: SessionAccess
  ) {
    const token = access?.token ?? null;
    this.#register(
      method,
      path,
      { kind: 'session', token },
      [this.deps.session.requireSession, tokenGate(token), handler],
      contract
    );
  }

  /**
   * A JSON API route from its shared contract (`contracts` in @openrows/shared): `'public'` for
   * anyone, `'session'` for any signed-in user, or a resource rule as in `resource`. The handler gets the validated
   * request and returns the response data.
   */
  endpoint<E extends EndpointDef>(
    contract: E,
    access: 'session',
    handler: EndpointHandler<E, SessionEnv>,
    tokens?: SessionAccess
  ): void;
  /** Anyone, without a session: the handler checks its own credential (a share token). */
  endpoint<E extends EndpointDef>(
    contract: E,
    access: 'public',
    handler: EndpointHandler<E, AppEnv>
  ): void;
  endpoint<E extends EndpointDef, K extends ResourceKind>(
    contract: E,
    access: ResourceAccess<K>,
    handler: EndpointHandler<E, ResourceEnv<K>>
  ): void;
  endpoint(
    contract: EndpointDef,
    access: 'public' | 'session' | ResourceAccess<ResourceKind>,
    handler: (c: never, request: never) => unknown,
    tokens?: SessionAccess
  ): void {
    // The overloads tie the handler's context to the access rule; here it's one of the two.
    const wrapped = contractHandler(
      contract,
      handler as unknown as EndpointHandler<EndpointDef, Env>
    ) as unknown as Handler<ResourceEnv> & Handler<SessionEnv>;
    if (access === 'public') {
      this.#register(contract.method, contract.path, { kind: 'public' }, [wrapped], contract);
    } else if (access === 'session') {
      this.session(contract.method, contract.path, wrapped, contract, tokens);
    } else {
      this.resource(contract.method, contract.path, access, wrapped, contract);
    }
  }

  /**
   * Personal access tokens only (`Authorization: Bearer or_pat_…`, any scope): a request without
   * one is 401 and the session cookie is never read, so a browser can't be made to call it.
   */
  token(method: Method, path: string, handler: Handler<SessionEnv>) {
    this.#register(method, path, { kind: 'token' }, [
      requireBearer,
      this.deps.session.requireSession,
      handler,
    ]);
  }

  /**
   * A system admin route of the ops console (registered by the hosted edition through the `routes` hook):
   * a contract endpoint behind `requireSystemAdmin`. The handler reaches across tenants only
   * through the console's SECURITY DEFINER functions (0080_admin_console_rls.sql).
   */
  admin<E extends EndpointDef>(contract: E, handler: EndpointHandler<E, SessionEnv>) {
    const wrapped = contractHandler(contract, handler) as unknown as MiddlewareHandler;
    this.#register(
      contract.method,
      contract.path,
      { kind: 'admin' },
      [this.deps.session.optionalSession, requireSystemAdmin, wrapped],
      contract
    );
  }

  resource<K extends ResourceKind>(
    method: Method,
    path: string,
    access: ResourceAccess<K>,
    handler: Handler<ResourceEnv<K>>,
    contract?: EndpointDef
  ) {
    const param = access.param ?? `${access.resource}Id`;
    const token = access.token === undefined ? ACTION_SCOPES[access.action] : access.token;
    if (!path.split('/').includes(`:${param}`)) {
      throw new Error(
        `route ${method} ${path} has no :${param} parameter for its ${access.resource}`
      );
    }
    this.#register(
      method,
      path,
      { kind: 'resource', resource: access.resource, action: access.action, param, token },
      [
        this.deps.session.requireSession,
        withResource(this.deps.db, access.resource, access.action, { param, scope: token }),
        handler,
      ],
      contract
    );
  }
}

/** Routes on `app` that didn't come through `registry` (middleware excluded). */
export function unregisteredRoutes<E extends Env>(app: Hono<E>, registry: RouteRegistry): string[] {
  const known = new Set(registry.entries.map((e) => `${e.method} ${e.path}`));
  const routes = new Set(
    app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`)
  );
  return [...routes].filter((r) => !known.has(r));
}
