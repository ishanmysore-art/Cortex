"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard route error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Your data is safe. Please try loading this area again.
      </p>
      <Button type="button" className="mt-6" onClick={reset}>Try again</Button>
    </main>
  );
}
