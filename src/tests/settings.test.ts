import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { effectiveSettings, SETTINGS, validateSetting } from "../settings";

describe("PiSettings", () => {
  it("stores, validates, and resets settings", async () => {
    const settings = env.PiSettings.getByName(`test-${crypto.randomUUID()}`);
    expect(await settings.all()).toEqual({});

    // 存一个合法值
    expect(await settings.set("PI_MODEL_INPUT", "text,image")).toEqual({
      PI_MODEL_INPUT: "text,image"
    });
    // 等于默认值 = 清掉
    expect(await settings.set("PI_MODEL_INPUT", "text")).toEqual({});
    // 空 / null = 清掉
    await settings.set("PI_SIDE_ROUTE", "pi-side");
    expect(await settings.set("PI_SIDE_ROUTE", null)).toEqual({});
    await settings.set("PI_SIDE_ROUTE", "  pi-side  ");
    expect((await settings.all()).PI_SIDE_ROUTE).toBe("pi-side");

    // 校验
    await expect(settings.set("PI_MODEL_INPUT", "audio")).rejects.toThrow(/只能是/);
    await expect(settings.set("PI_CONTEXT_WINDOW", "abc")).rejects.toThrow(/数字/);
    await expect(settings.set("PI_CONTEXT_WINDOW", "10")).rejects.toThrow(/不能小于/);
    await expect(settings.set("NOT_A_SETTING", "x")).rejects.toThrow(/not a setting/);

    // 内部标记行不暴露
    expect(Object.keys(await settings.all())).toEqual(["PI_SIDE_ROUTE"]);
  });

  it("fills defaults for everything not set", () => {
    const effective = effectiveSettings({ PI_MAX_TOKENS: "4096" });
    expect(Object.keys(effective).sort()).toEqual(SETTINGS.map((d) => d.name).sort());
    expect(effective.PI_MAX_TOKENS).toBe("4096");
    expect(effective.PI_CONTEXT_WINDOW).toBe("128000");
    expect(effective.PI_FETCH_ALLOW).toBe("*");
  });

  it("validates per kind", () => {
    const select = SETTINGS.find((d) => d.name === "PI_MODEL_REASONING")!;
    expect(validateSetting(select, "true")).toBeUndefined();
    expect(validateSetting(select, "yes")).toMatch(/只能是/);
    const number = SETTINGS.find((d) => d.name === "PI_PRICE_INPUT")!;
    expect(validateSetting(number, "0.5")).toBeUndefined();
    expect(validateSetting(number, "-1")).toMatch(/不能小于/);
    const text = SETTINGS.find((d) => d.name === "PI_FETCH_ALLOW")!;
    expect(validateSetting(text, "anything")).toBeUndefined();
  });
});
