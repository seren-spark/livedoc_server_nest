import type { AgentMessage } from "../../src/ai/document-agent.types.js";

// Ordinary API regressions still traverse the real supervisor and scheduler.
export function supervisorResponse(messages: AgentMessage[]) {
  const context = JSON.parse(
    messages.find((message) => message.role === "user")?.content ?? "{}",
  );
  if (context.purpose !== "supervisor") return;
  const research = context.ready
    .filter((step: any) => step.capability !== "compose")
    .slice(0, 3);
  const batch = research.length ? research : context.ready.slice(0, 1);
  return {
    message: {
      role: "assistant" as const,
      content: JSON.stringify(
        batch.length
          ? { action: "dispatch", task_ids: batch.map((step: any) => step.id) }
          : { action: "compose" },
      ),
    },
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  };
}
