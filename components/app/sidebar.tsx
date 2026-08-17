"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { SidebarNav } from "@/components/app/sidebar-nav";
import { SignOutButton } from "@/components/app/sign-out-button";

type SidebarProps = {
  email: string;
};

export function Sidebar({ email }: SidebarProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <aside className="flex w-full flex-col border-b border-border/60 md:w-56 md:min-h-screen md:border-b-0 md:border-r">
      <div className="flex items-center justify-between px-6 py-4 md:py-5">
        <Link href="/dashboard" onClick={() => setIsOpen(false)} className="text-base font-semibold tracking-tight">
          Cortex
        </Link>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label="Toggle navigation menu"
          className="rounded-md p-1 text-muted hover:text-foreground md:hidden"
        >
          {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <div className={`${isOpen ? "block" : "hidden"} flex-col pb-4 md:flex md:flex-1 md:pb-0`}>
        <SidebarNav onNavigate={() => setIsOpen(false)} />

        <div className="mt-auto border-t border-border/60 px-3 py-4">
          <p className="truncate px-3 pb-2 text-xs text-muted">{email}</p>
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}
