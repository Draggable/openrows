/**
 * Central authorization (ADR-002). Every route is registered through `RouteRegistry`, and
 * every resource route goes through `withResource`, which resolves the resource's workspace and
 * the user's role in one query, calls `authorize`, and runs the handler in a transaction with
 * RLS scoped to that workspace.
 */
export { type ResourceEnv, withResource } from './middleware.js';
export {
  type AuthorizedResource,
  assertAllowed,
  assertSession,
  authorize,
  type Decision,
  effectiveRole,
  principalMay,
  type ResolvedResource,
  tokenReaches,
} from './policy.js';
export { resolveResource } from './resolve.js';
export {
  type Access,
  type Method,
  type RouteEntry,
  RouteRegistry,
  unregisteredRoutes,
} from './routes.js';
export { inScope, type Scope, setScope } from './scope.js';
