"use client";

import { useRef, useState, useTransition } from "react";
import { archiveMemory, addMemory } from "@/app/actions/memories";
import { Button } from "@/components/ui/button";

type Memory = { id: string; content: string };

export function MemoryPanel({ memories }: { memories: Memory[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await addMemory(formData);
      if ("error" in result && typeof result.error === "string") setError(result.error);
      else formRef.current?.reset();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await archiveMemory(id);
      if ("error" in result && typeof result.error === "string") setError(result.error);
    });
  }

  return (
    <aside className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Memory</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Only memories you add here are used in future conversations. Remove them anytime.
      </p>

      <form ref={formRef} action={submit} className="mt-3 space-y-2">
        <label className="sr-only" htmlFor="memory-content">Add a memory</label>
        <textarea
          id="memory-content"
          name="content"
          maxLength={1000}
          rows={3}
          disabled={isPending}
          placeholder="e.g. I prefer concise answers."
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-foreground disabled:opacity-50"
        />
        <Button type="submit" size="sm" disabled={isPending}>Save memory</Button>
      </form>

      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}

      {memories.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-border/60 pt-3">
          {memories.map((memory) => (
            <li key={memory.id} className="flex items-start justify-between gap-3 text-sm">
              <span className="leading-relaxed text-muted-foreground">{memory.content}</span>
              <button
                type="button"
                disabled={isPending}
                onClick={() => remove(memory.id)}
                className="shrink-0 text-xs text-muted-foreground hover:text-red-600 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
