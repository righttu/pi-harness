import { describe, expect, it } from "vitest";
import type { Api, Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { routeStreams } from "../route-model";

describe("routeStreams", () => {
  it("rewrites the request model at request time and keeps caller onPayload", async () => {
    const seen: unknown[] = [];
    // 假的 API：像真的一样调用 onPayload，记下最后的请求体。
    const fake = {
      stream: (model: Model<Api>, _context: unknown, options?: StreamOptions) => {
        void (async () => {
          const payload = { model: model.id, messages: [] };
          seen.push((await options?.onPayload?.(payload, model)) ?? payload);
        })();
        return undefined as never;
      },
      streamSimple: () => undefined as never
    } as unknown as ProviderStreams;
    let route = "pi-route";
    const routed = routeStreams(fake, () => `dynamic/${route}`);
    const model = { id: "dynamic/pi-side" } as Model<Api>;

    routed.stream(model, {} as never, {
      onPayload: (payload) => ({ ...(payload as object), extra: 1 })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    route = "pi-cheap";
    routed.stream(model, {} as never, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([
      { model: "dynamic/pi-route", messages: [], extra: 1 },
      { model: "dynamic/pi-cheap", messages: [] }
    ]);
  });
});
