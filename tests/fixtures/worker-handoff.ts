// Controlled model responses explicitly implement the worker handoff protocol.
export function handoffArguments(args: any) {
  return { ...args, handoff: {
    findings: args.citation_ids?.length ? [{ statement: args.answer.slice(0, 500), evidence_ids: args.citation_ids }] : [],
    missing: args.citation_ids?.length ? [] : [args.answer.slice(0, 300)],
    conflicts: [],
  } };
}
