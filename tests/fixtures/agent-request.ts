import type { DocumentAgentDto } from "../../src/ai/document-agent.dto.js";
export function request(mode = "agent"): DocumentAgentDto {
  const nodes = [
    { type: "paragraph", content: [{ type: "text", text: "first" }] },
    { type: "paragraph", content: [{ type: "text", text: "second" }] },
  ];
  return {
    request_id: "r",
    conversation_id: "c",
    mode: mode as any,
    output_target: "current_document",
    query: "改写当前选区",
    deep_thinking: false,
    allow_web: false,
    references: [],
    editor_snapshot: {
      identity: { kind: "unsaved", local_id: "doc" },
      title: "test",
      json: { type: "doc", content: nodes },
      revision: 0,
      hash: "test",
      selection: { text: "first", inline: true, region_ids: ["b0"] },
      regions: nodes.map((n, i) => ({
        id: `b${i}`,
        type: "paragraph",
        text: n.content[0]!.text,
        markdown: n.content[0]!.text,
        heading_path: [],
        original_json: n,
      })),
    },
  };
}
