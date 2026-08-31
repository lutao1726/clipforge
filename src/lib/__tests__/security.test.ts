import { describe, it, expect } from "vitest";
import { resolveUploadFilePath, toPublicUsableImage } from "@/lib/remote-image";
import { escapeSsml } from "@/lib/edge-tts";

// ==================== path traversal protection (toRemoteUsableImage in /api/ai/image|video) ====================

describe("resolveUploadFilePath 路径穿越防护", () => {
  it("正常 /api/files 路径解析到 uploads 目录内", () => {
    const p = resolveUploadFilePath("/api/files/abc.png");
    expect(p).toBeTruthy();
    expect(p!.includes("uploads")).toBe(true);
    expect(p!.endsWith(`abc.png`)).toBe(true);
  });

  it("含 ../ 的路径穿越被拒绝（返回 null，不读盘外泄）", () => {
    expect(resolveUploadFilePath("/api/files/../../../../etc/passwd")).toBeNull();
    expect(resolveUploadFilePath("/api/files/../config")).toBeNull();
    expect(resolveUploadFilePath("/api/files/sub/../../../secret")).toBeNull();
  });

  it("非 /api/files 路径返回 null（交由调用方原样透传）", () => {
    expect(resolveUploadFilePath("https://example.com/x.png")).toBeNull();
    expect(resolveUploadFilePath("random-string")).toBeNull();
  });
});

describe("toPublicUsableImage 公网代理地址", () => {
  it("把本地上传路由映射到公网 origin，供不接受 Data URI 的视频平台读取", () => {
    expect(toPublicUsableImage("/api/files/p/demo.png", "https://ai.example.test/")).toBe(
      "https://ai.example.test/api/files/p/demo.png"
    );
  });

  it("已有公网 URL、Data URI 和无 origin 时保持原值", () => {
    expect(toPublicUsableImage("https://cdn.example.test/a.png", "https://ai.example.test")).toBe("https://cdn.example.test/a.png");
    expect(toPublicUsableImage("data:image/png;base64,abc", "https://ai.example.test")).toBe("data:image/png;base64,abc");
    expect(toPublicUsableImage("/api/files/p/demo.png", undefined)).toBe("/api/files/p/demo.png");
  });
});

// ==================== SSML attribute injection protection (fallback escaping for edge-tts voice/pitch/rate) ====================

describe("escapeSsml 防 SSML 属性注入", () => {
  it("转义单引号/尖括号——voice/rate 落在单引号属性里靠它兜底，未转义的 ' 可越界注入", () => {
    const out = escapeSsml("x' /><voice name='evil");
    expect(out).not.toContain("'"); // single quotes must be escaped; unescaped ones can break out of the attribute and inject new elements
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("&apos;");
    expect(out).toContain("&lt;");
  });

  it("合法音色名无副作用（转义是无害的兜底）", () => {
    expect(escapeSsml("en-US-AriaNeural")).toBe("en-US-AriaNeural");
    expect(escapeSsml("+10%")).toBe("+10%");
  });
});
