import type { contracts } from '@openrows/shared';
import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type * as V1 from './generated/v1.js';
import type { OpenRowsRecord, Webhook } from './types.js';

type C = typeof contracts;
type In<S> = S extends z.ZodType ? z.input<S> : never;
type Out<S> = S extends z.ZodType ? z.output<S> : never;
type Extends<A, B> = [A] extends [B] ? true : false;

/**
 * The generated types say what the contracts say: each is assignable both ways to Zod's own type
 * of the schema it came from (the codegen test keeps the file current; this checks the codegen).
 */
describe('the generated types and the contracts', () => {
  it('agree on bodies, queries and answers', () => {
    // Coerced numbers (`pageSize`) are `unknown` to Zod's input type and `number` here.
    expectTypeOf<
      Extends<V1.V1RecordsListPostBody, In<C['v1Records']['listPost']['body']>>
    >().toEqualTypeOf<true>();
    expectTypeOf<V1.V1RecordsCreateBody>().toExtend<In<C['v1Records']['create']['body']>>();
    expectTypeOf<In<C['v1Records']['create']['body']>>().toExtend<V1.V1RecordsCreateBody>();
    expectTypeOf<V1.V1RecordsUpdateManyBody>().toExtend<In<C['v1Records']['updateMany']['body']>>();
    expectTypeOf<V1.V1WebhooksCreateBody>().toEqualTypeOf<In<C['v1Webhooks']['create']['body']>>();
    expectTypeOf<V1.V1WebhooksUpdateBody>().toEqualTypeOf<In<C['v1Webhooks']['update']['body']>>();
    expectTypeOf<V1.V1MetaCreateTableBody>().toEqualTypeOf<
      In<C['v1Meta']['createTable']['body']>
    >();
    expectTypeOf<V1.V1CommentsListQuery>().toExtend<In<C['v1Comments']['list']['query']>>();

    expectTypeOf<V1.V1RecordsGetResponse>().toEqualTypeOf<Out<C['v1Records']['get']['response']>>();
    expectTypeOf<V1.V1MetaTablesResponse>().toExtend<Out<C['v1Meta']['tables']['response']>>();
    expectTypeOf<Out<C['v1Meta']['tables']['response']>>().toExtend<V1.V1MetaTablesResponse>();
    expectTypeOf<V1.V1WebhooksListResponse>().toEqualTypeOf<
      Out<C['v1Webhooks']['list']['response']>
    >();
    expectTypeOf<V1.V1CommentsListResponse>().toEqualTypeOf<
      Out<C['v1Comments']['list']['response']>
    >();
  });

  it('give the SDK its record and webhook types', () => {
    expectTypeOf<OpenRowsRecord>().toExtend<Out<C['v1Records']['get']['response']>>();
    expectTypeOf<Webhook['events']>().toEqualTypeOf<
      Out<C['v1Webhooks']['list']['response']>['webhooks'][number]['events']
    >();
  });
});
