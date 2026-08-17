import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="mx-auto flex max-w-3xl flex-col items-center px-6 py-32 text-center">
      <p className="mb-4 text-sm font-medium tracking-wide text-muted uppercase">
        Your second brain
      </p>

      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl sm:leading-tight">
        An AI operating system
        <br />
        for your thinking
      </h1>

      <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted text-pretty">
        Upload notes. Discover connections. Ask questions.
        Cortex remembers what you learn and helps you think
        more deeply — over years, not sessions.
      </p>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Button size="lg" asChild>
          <Link href="/signup">Get started</Link>
        </Button>
        <Button variant="secondary" size="lg" asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </section>
  );
}
