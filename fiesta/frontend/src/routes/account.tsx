import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Field } from "../components/admin/admin-ui";
import { ErrorMessage } from "../components/error-message";
import { useLoginModal, useSignInProviders } from "../components/login-modal";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PROFILE_LABELS, returnTo, sendSignInLink, startProviderSignIn } from "../lib/sign-in";
import type { UserOut } from "../lib/types";

/** The signed-in user's own account (one EarthRef login for every node):
 * profile (PATCH /v2/auth/me; publication needs first and last name,
 * affiliation and a verified email), email, connected sign-ins, and a
 * password for scripts (POST /v2/auth/password). */
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
        {user.profile_missing.length > 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Before you can publish, add your{" "}
            {user.profile_missing.map((m) => PROFILE_LABELS[m] ?? m).join(", ")}.
          </p>
        )}
        {/* Keyed so the form resets to the saved values after each save. */}
        <ProfileCard
          key={JSON.stringify([
            user.first_name,
            user.last_name,
            user.affiliation,
            user.handle,
            user.name,
          ])}
          user={user}
        />
        <EmailCard key={user.email} user={user} />
        <SignInsCard user={user} />
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
  const [first, setFirst] = useState(user.first_name ?? "");
  const [last, setLast] = useState(user.last_name ?? "");
  const [affiliation, setAffiliation] = useState(user.affiliation ?? "");
  const [handle, setHandle] = useState(user.handle ?? "");

  // Only changed fields are sent; the display name follows the first and last names.
  const changes: Record<string, string | null> = {};
  if (first.trim() !== (user.first_name ?? "")) changes.first_name = first.trim() || null;
  if (last.trim() !== (user.last_name ?? "")) changes.last_name = last.trim() || null;
  if (affiliation.trim() !== (user.affiliation ?? ""))
    changes.affiliation = affiliation.trim() || null;
  if (handle.trim() !== (user.handle ?? "")) changes.handle = handle.trim() || null;
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
          <p className="text-gray-600">
            Your name and affiliation are published with your contributions.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input
                autoComplete="given-name"
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            </Field>
            <Field label="Last name">
              <Input
                autoComplete="family-name"
                value={last}
                onChange={(e) => setLast(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Affiliation" hint="Department, institution.">
            <Input
              autoComplete="organization"
              value={affiliation}
              onChange={(e) => setAffiliation(e.target.value)}
            />
          </Field>
          <Field label="Handle" hint="Optional: a short name for your account.">
            <Input
              value={handle}
              pattern="[A-Za-z0-9_.\-]{2,64}"
              title="2–64 letters, digits, dots, dashes or underscores"
              onChange={(e) => setHandle(e.target.value)}
            />
          </Field>
          {save.isError && <ErrorMessage error={save.error} />}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || save.isPending}>
              Save Profile
            </Button>
            <Saved show={save.isSuccess && !dirty} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The account's address: verified by using an emailed link; a new address
 * takes effect once its confirmation link is used. */
function EmailCard({ user }: { user: UserOut }) {
  const [email, setEmail] = useState("");
  const verify = useMutation({ mutationFn: () => sendSignInLink(user.email) });
  const change = useMutation({
    mutationFn: () =>
      api("/v2/auth/email-change", {
        method: "POST",
        json: { email: email.trim(), return_to: returnTo() },
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-gray-700">
          <strong>{user.email}</strong>{" "}
          {user.email_verified ? (
            <span className="text-node-ink">verified</span>
          ) : (
            <span className="text-amber-700">not verified</span>
          )}
        </p>
        {!user.email_verified && (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={verify.isPending || verify.isSuccess}
              onClick={() => verify.mutate()}
            >
              Send Verification Link
            </Button>
            {verify.isSuccess && <span className="text-gray-600">Check your email.</span>}
            {verify.isError && <ErrorMessage error={verify.error} />}
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            change.mutate();
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Field label="Change to" hint="We email the new address a link to confirm it.">
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  change.reset();
                }}
              />
            </Field>
          </div>
          <Button type="submit" disabled={!email.trim() || change.isPending}>
            Send Confirmation
          </Button>
        </form>
        {change.isSuccess && (
          <p className="text-gray-600">Check {email.trim()} for the confirmation link.</p>
        )}
        {change.isError && <ErrorMessage error={change.error} />}
      </CardContent>
    </Card>
  );
}

/** External accounts that sign in to this one; ORCID also records the iD. */
function SignInsCard({ user }: { user: UserOut }) {
  const queryClient = useQueryClient();
  const providers = useSignInProviders();
  const connect = useMutation({ mutationFn: (id: string) => startProviderSignIn(id, true) });
  const disconnect = useMutation({
    mutationFn: (id: string) => api<void>(`/v2/auth/identities/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
  if (!providers.length && !user.orcid) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-In Methods</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-gray-600">
          An emailed link to your address always works. Connect accounts to sign in with them too.
        </p>
        {user.orcid && (
          <p className="text-gray-700">
            ORCID iD:{" "}
            <a className="text-node-ink hover:underline" href={`https://orcid.org/${user.orcid}`}>
              {user.orcid}
            </a>
          </p>
        )}
        <ul className="divide-y divide-gray-100">
          {providers.map((p) => {
            const connected = user.sign_ins.includes(p.id);
            return (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span className="text-gray-800">
                  {p.name}
                  {connected && <span className="ml-2 text-node-ink">connected</span>}
                </span>
                {connected ? (
                  <Button
                    variant="secondary"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate(p.id)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate(p.id)}
                  >
                    Connect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {(connect.error || disconnect.error) && (
          <ErrorMessage error={connect.error ?? disconnect.error} />
        )}
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
        <CardTitle>Password for Scripts</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-gray-600">
          You never need a password to sign in here. Set one only for scripts and the
          api.earthref.org HTTP Basic login.
        </p>
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
