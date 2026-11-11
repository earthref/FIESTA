import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Field } from "../components/admin/admin-ui";
import { ErrorMessage } from "../components/error-message";
import { useLoginModal } from "../components/login-modal";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { UserOut } from "../lib/types";

/** The signed-in user's own account (one EarthRef login for every node):
 * profile fields (PATCH /v2/auth/me) and password (POST /v2/auth/password). */
export function AccountPage() {
  const { user, isLoading } = useAuth();
  const { openLogin } = useLoginModal();

  if (isLoading) return <PageSpinner label="Checking your session…" />;
  if (!user) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Account</h1>
        <p className="mb-5 text-sm text-gray-600">Log in to manage your EarthRef account.</p>
        <Button onClick={openLogin}>Log In / Register</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Account</h1>
      <p className="mb-5 text-sm text-gray-600">
        One EarthRef account signs you in to every EarthRef.org repository.
      </p>
      <div className="space-y-4">
        {/* Keyed so the form resets to the saved values after each save. */}
        <ProfileCard
          key={JSON.stringify([user.name, user.email, user.handle, user.orcid])}
          user={user}
        />
        <PasswordCard hasPassword={user.has_password} />
        {(user.is_admin || user.admin_nodes.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle>Roles</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-gray-600">
              {user.is_admin
                ? "Super admin: every node, node creation and accounts."
                : `Node admin: ${user.admin_nodes.join(", ")}.`}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? <span className="text-sm text-node-ink">Saved.</span> : null;
}

function ProfileCard({ user }: { user: UserOut }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [handle, setHandle] = useState(user.handle ?? "");
  const [orcid, setOrcid] = useState(user.orcid ?? "");

  // Only changed fields are sent: an unchanged address is never re-validated.
  const changes: Record<string, string | null> = {};
  if (name.trim() !== user.name) changes.name = name.trim();
  if (email.trim().toLowerCase() !== user.email) changes.email = email.trim();
  if (handle.trim() !== (user.handle ?? "")) changes.handle = handle.trim() || null;
  if (orcid.trim() !== (user.orcid ?? "")) changes.orcid = orcid.trim() || null;
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => api<UserOut>("/v2/auth/me", { method: "PATCH", json: changes }),
    onSuccess: (saved) => queryClient.setQueryData(["auth", "me"], saved),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3 text-sm" onSubmit={submit}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Email" hint="You log in with this address.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Handle" hint="Optional: log in with it instead of your email.">
              <Input
                value={handle}
                pattern="[A-Za-z0-9_.\-]{2,64}"
                title="2–64 letters, digits, dots, dashes or underscores"
                onChange={(e) => setHandle(e.target.value)}
              />
            </Field>
            <Field label="ORCID">
              <Input
                value={orcid}
                placeholder="0000-0000-0000-0000"
                pattern="\d{4}-\d{4}-\d{4}-\d{3}[\dX]"
                title="16 digits in four groups, e.g. 0000-0002-1825-0097"
                onChange={(e) => setOrcid(e.target.value)}
              />
            </Field>
          </div>
          {save.isError && <ErrorMessage error={save.error} />}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || !name.trim() || save.isPending}>
              Save Profile
            </Button>
            <Saved show={save.isSuccess && !dirty} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm !== "" && next !== confirm;

  const save = useMutation({
    mutationFn: () =>
      api<void>("/v2/auth/password", {
        json: { current_password: hasPassword ? current : null, new_password: next },
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      if (!hasPassword) queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasPassword ? "Change Password" : "Set a Password"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {hasPassword && (
            <Field label="Current password">
              <Input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" hint="At least 8 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </Field>
          </div>
          {mismatch && <p className="text-sm text-red-700">The passwords do not match.</p>}
          {save.isError && <ErrorMessage error={save.error} />}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={next.length < 8 || next !== confirm || save.isPending}>
              {hasPassword ? "Change Password" : "Set Password"}
            </Button>
            <Saved show={save.isSuccess && next === ""} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
