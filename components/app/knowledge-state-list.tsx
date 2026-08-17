export type KnowledgeStateItem = {
  conceptId: string;
  label: string;
  encounterCount: number;
  encounterDocumentCount: number;
  retrievalCount: number;
  retrievalAnswerCount: number;
  lastEncounteredAt: string | null;
  lastRetrievedAt: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Counts and dates only.
 *
 * Deliberately not sorted or styled as a ranking of how well anything is known:
 * the log supports "you have met this eight times", not "you know this well".
 */
export function KnowledgeStateList({ states }: { states: KnowledgeStateItem[] }) {
  if (states.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/10 p-8 text-center text-sm text-muted-foreground">
        Nothing yet. Upload documents and ask questions, and Cortex will track how often each idea
        shows up in your material and in its answers.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">
          Concepts, how often you have encountered them, and how often they have been cited
        </caption>
        <thead className="bg-surface/60 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-medium">
              Concept
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Encountered
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Cited
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Last seen
            </th>
          </tr>
        </thead>
        <tbody>
          {states.map((state) => (
            <tr key={state.conceptId} className="border-t border-border/60">
              <td className="px-4 py-2.5">{state.label}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                {state.encounterCount}
                <span className="ml-1 text-xs">
                  ({state.encounterDocumentCount} doc
                  {state.encounterDocumentCount === 1 ? "" : "s"})
                </span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                {state.retrievalCount}
                {state.retrievalAnswerCount > 0 && (
                  <span className="ml-1 text-xs">
                    ({state.retrievalAnswerCount} answer
                    {state.retrievalAnswerCount === 1 ? "" : "s"})
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                {formatDate(state.lastEncounteredAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
