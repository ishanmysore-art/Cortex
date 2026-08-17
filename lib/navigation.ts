export type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
};

export const dashboardNav: NavItem[] = [
  { href: "/dashboard", label: "Home", exact: true },
  { href: "/dashboard/notes", label: "Notes" },
  { href: "/dashboard/search", label: "Search" },
  { href: "/dashboard/ask", label: "Ask" },
  { href: "/dashboard/model", label: "Your model" },
];
