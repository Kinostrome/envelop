/* eslint-disable no-console */
import { makeExecute, makeSubscribe, Plugin, TypedExecutionArgs } from '@envelop/core';
import { DocumentNode, Source, ExecutionArgs, ExecutionResult } from '@graphql-tools/graphql';
import { compileQuery, isCompiledQuery, CompilerOptions, CompiledQuery } from 'graphql-jit';
import LRU from 'lru-cache';
import { compatSchema } from '@graphql-tools/compat';

const DEFAULT_MAX = 1000;
const DEFAULT_TTL = 3600000;

type JITCacheEntry = {
  query: CompiledQuery['query'];
  subscribe?: CompiledQuery['subscribe'];
};

export interface JITCache {
  get(key: string): JITCacheEntry | undefined;
  set(key: string, value: JITCacheEntry): void;
}

export const useGraphQlJit = (
  compilerOptions: Partial<CompilerOptions> = {},
  pluginOptions: {
    /**
     * A helper function that helps to conditionally enable JIT based on incoming request
     */
    enableIf?: (executionArgs: ExecutionArgs) => boolean | Promise<boolean>;
    /**
     * Callback triggered in case of GraphQL Jit compilation error.
     */
    onError?: (r: ExecutionResult) => void;
    /**
     * Custom cache instance
     */
    cache?: JITCache;
  } = {}
): Plugin => {
  const documentSourceMap = new WeakMap<DocumentNode, string>();
  const jitCache =
    typeof pluginOptions.cache !== 'undefined'
      ? pluginOptions.cache
      : new LRU<string, JITCacheEntry>({ max: DEFAULT_MAX, maxAge: DEFAULT_TTL });

  function getCacheEntry<T>(args: TypedExecutionArgs<T>): JITCacheEntry {
    let cacheEntry: JITCacheEntry | undefined;
    const documentSource = documentSourceMap.get(args.document);

    if (documentSource) {
      cacheEntry = jitCache.get(documentSource);
    }

    if (!cacheEntry) {
      // TODO: CACHE ME
      const schema = compatSchema(args.schema);
      const compilationResult = compileQuery(schema, args.document, args.operationName ?? undefined, compilerOptions);

      if (!isCompiledQuery(compilationResult)) {
        if (pluginOptions?.onError) {
          pluginOptions.onError(compilationResult);
        } else {
          console.error(compilationResult);
        }
        cacheEntry = {
          query: () => compilationResult,
        };
      } else {
        cacheEntry = compilationResult;
      }

      if (documentSource) {
        jitCache.set(documentSource, cacheEntry);
      }
    }
    return cacheEntry;
  }

  return {
    onParse({ params: { source } }) {
      const key = source instanceof Source ? source.body : source;

      return ({ result }) => {
        if (!result || result instanceof Error) return;

        documentSourceMap.set(result, key);
      };
    },
    async onExecute({ args, setExecuteFn }) {
      if (!pluginOptions.enableIf || (pluginOptions.enableIf && (await pluginOptions.enableIf(args)))) {
        setExecuteFn(
          makeExecute(function jitExecutor(args) {
            const cacheEntry = getCacheEntry(args as TypedExecutionArgs<unknown>);

            return cacheEntry.query(args.rootValue, args.contextValue, args.variableValues);
          })
        );
      }
    },
    async onSubscribe({ args, setSubscribeFn }) {
      if (!pluginOptions.enableIf || (pluginOptions.enableIf && (await pluginOptions.enableIf(args)))) {
        setSubscribeFn(
          makeSubscribe(async function jitSubscriber(args) {
            const cacheEntry = getCacheEntry(args as TypedExecutionArgs<unknown>);

            return cacheEntry.subscribe
              ? (cacheEntry.subscribe(args.rootValue, args.contextValue, args.variableValues) as any)
              : cacheEntry.query(args.rootValue, args.contextValue, args.variableValues);
          })
        );
      }
    },
  };
};
