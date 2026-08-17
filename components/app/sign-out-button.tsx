import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <Button
        variant="ghost"
        size="sm"
        type="submit"
        className="w-full justify-start text-muted"
      >
        Sign out
      </Button>
    </form>
  );
}
