import { describe, expect, it } from "vitest";
import { formatTopicGuidance } from "@/lib/prompt";

describe("formatTopicGuidance", () => {
  it("renders one line per topic, and None. when there are none", () => {
    expect(formatTopicGuidance([])).toBe("None.");
    expect(formatTopicGuidance([{ topic: "  ", guidance: "x" }, { topic: "t", guidance: "  " }])).toBe("None.");
    expect(formatTopicGuidance([
      { topic: "husband", guidance: "Answer gently, then offer to call her daughter." },
      { topic: " driving ", guidance: " Suggest asking family. " },
    ])).toBe("- husband: Answer gently, then offer to call her daughter.\n- driving: Suggest asking family.");
  });
});
