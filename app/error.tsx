"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Unhandled application error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-semibold">Cortex needs a moment</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        The request did not complete. Please try again.
      </p>
      <Button type="button" className="mt-6" onClick={reset}>Try again</Button>
    </main>
  );
}
