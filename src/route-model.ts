// ============================================================================
// 模型 id 和 AI Gateway 路由名分开。
//
// pi 把每个对话用的模型 id 存在对话配置里（子代理的对话也一样）。如果 id 就是
// 路由名（"dynamic/pi-side"），改了 PI_SIDE_ROUTE 之后，已有子代理还记着旧 id，
// 不会跟着换，旧 id 从 provider 里删掉后还会直接报错。
//
// 所以 pi 这边用两个固定 id（lead / side），真正发给 AI Gateway 的路由名在每次
// 请求时按当前配置决定：包一层 ProviderStreams，在 onPayload 里改请求体的
// model 字段。配置一改，所有对话（含已有子代理）的下一次请求就走新路由。
// ============================================================================

import type { Api, Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";

/**
 * @param wire 给定 pi 的模型，返回请求体里实际用的 model（例如 "dynamic/pi-cheap"）。
 *             每次请求都调用，所以读的是当时的配置。
 */
export function routeStreams(
  api: ProviderStreams,
  wire: (model: Model<Api>) => string
): ProviderStreams {
  const withRoute = <O extends StreamOptions>(model: Model<Api>, options: O | undefined): O =>
    ({
      ...options,
      onPayload: async (payload: unknown, m: Model<Api>) => {
        const next = (await options?.onPayload?.(payload, m)) ?? payload;
        if (!next || typeof next !== "object") return next;
        return { ...(next as Record<string, unknown>), model: wire(model) };
      }
    }) as O;
  return {
    stream: (model, context, options) => api.stream(model, context, withRoute(model, options)),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, withRoute(model, options)),
    ...(api.fetchDeferred ? { fetchDeferred: api.fetchDeferred.bind(api) } : {}),
    ...(api.cancelDeferred ? { cancelDeferred: api.cancelDeferred.bind(api) } : {})
  };
}
