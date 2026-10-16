import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { callProvider, streamProvider } from "./ai-provider";
import type { TrpcContext } from "./_core/context";

const publicContext = {
  user: null,
  req: {} as TrpcContext["req"],
  res: {} as TrpcContext["res"],
};

describe("ai router", () => {
  it("returns a useful response from the local Cz Core provider", async () => {
    const caller = appRouter.createCaller(publicContext);
    const result = await caller.ai.chat({
      provider: { kind: "demo", model: "Cz-Reasoner" },
      messages: [{ role: "user", content: "اكتب لي فكرة" }],
    });

    expect(result.content).toContain("وصلت فكرتك");
    expect(result.content).toContain("Cz Core");
  });

  it("verifies the local provider without requiring a key", async () => {
    const caller = appRouter.createCaller(publicContext);
    await expect(caller.ai.verify({ provider: { kind: "demo", model: "Cz-Reasoner" } })).resolves.toEqual({ success: true });
  });

  it("streams the local provider in multiple chunks", async () => {
    const chunks: string[] = [];
    for await (const chunk of streamProvider({ kind: "demo", model: "Cz-Reasoner" }, [{ role: "user", content: "اختبار البث" }])) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("QUIZ_JSON");
  });

  it("returns structured quiz and math content for rich rendering", async () => {
    const caller = appRouter.createCaller(publicContext);
    const quiz = await caller.ai.chat({ provider: { kind: "demo", model: "Cz-Reasoner" }, messages: [{ role: "user", content: "أنشئ اختبارًا" }] });
    const math = await caller.ai.chat({ provider: { kind: "demo", model: "Cz-Reasoner" }, messages: [{ role: "user", content: "حل معادلة" }] });

    expect(quiz.content).toContain("QUIZ_JSON");
    expect(math.content).toContain("$$x^2");
  });

  it("rejects external providers when no API key is supplied", async () => {
    const caller = appRouter.createCaller(publicContext);
    await expect(caller.ai.verify({ provider: { kind: "openai", model: "gpt-4o-mini" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("analyzes an enabled text attachment in the demo provider", async () => {
    const result = await callProvider({ kind: "demo", model: "Cz-Reasoner", supportsAttachments: true }, [{ role: "user", content: "حلل الملف", attachments: [{ name: "notes.txt", mimeType: "text/plain", text: "محتوى للاختبار" }] }]);
    expect(result).toContain("notes.txt");
  });

  it("rejects attachments when the model capability is disabled", async () => {
    await expect(callProvider({ kind: "demo", model: "Cz-Reasoner", supportsAttachments: false }, [{ role: "user", content: "", attachments: [{ name: "photo.png", mimeType: "image/png", data: "data:image/png;base64,AAAA" }] }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
