import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";

export default function DashboardPage() {
  return (
    <>
      <header className="border-b border-border/60 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Home</h1>
      </header>

      <EmptyState
        title="Welcome to Cortex"
        description="Your knowledge base starts here. Upload notes to begin building your second brain."
        action={
          <Button asChild>
            <Link href="/dashboard/notes">Go to Notes</Link>
          </Button>
        }
      />
    </>
  );
}
