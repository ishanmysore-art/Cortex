import { SignupForm } from "@/components/auth/signup-form";

export default function SignupPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="mt-2 text-sm text-muted">
        Start building your second brain.
      </p>
      <div className="mt-8">
        <SignupForm />
      </div>
    </div>
  );
}
