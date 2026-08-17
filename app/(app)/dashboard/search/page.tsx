import { SearchBar } from "@/components/app/search-bar";

export const metadata = {
  title: "Search — Cortex",
  description:
    "Semantically search your notes by meaning, not just keywords.",
};

export default function SearchPage() {
  return (
    <>
      <header className="border-b border-border/60 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Search</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Find ideas by meaning, not just keywords.
        </p>
      </header>

      <main className="p-6 max-w-3xl mx-auto">
        <SearchBar />
      </main>
    </>
  );
}
