import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  clearPendingSignIn,
  pendingSignIn,
  redeemSignInLink,
  type SignInProvider,
  sendSignInLink,
  startProviderSignIn,
} from "../lib/sign-in";
import { ErrorMessage } from "./error-message";
import { HavingTroubleButton } from "./footer";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

interface LoginModalContextValue {
  openLogin: () => void;
}

const LoginModalContext = createContext<LoginModalContextValue | null>(null);

export function useLoginModal(): LoginModalContextValue {
  const context = useContext(LoginModalContext);
  if (!context) throw new Error("useLoginModal must be used within LoginModalProvider");
  return context;
}

export function useSignInProviders(): SignInProvider[] {
  const { data } = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => api<{ providers: SignInProvider[] }>("/v2/auth/providers"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data?.providers ?? [];
}

/** Sign in or sign up without a password: an external account, or a one-time
 * link emailed to the address (which creates the account on first use). */
function LoginModalDialog({
  onClose,
  link,
  initialError,
}: {
  onClose: () => void;
  link?: string;
  initialError?: string;
}) {
  const { login } = useAuth();
  const providers = useSignInProviders();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => sendSignInLink(email.trim()),
    onSuccess: () => setSentTo(email.trim()),
  });
  const redeem = useMutation({
    mutationFn: () => redeemSignInLink(link ?? ""),
    onSuccess: (token) => {
      login(token.access_token);
      onClose();
    },
  });
  const provider = useMutation({ mutationFn: (id: string) => startProviderSignIn(id) });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!send.isPending) send.mutate();
  };

  const footer = (
    <>
      <div className="mr-auto flex">
        <HavingTroubleButton style={{ margin: 0 }} />
      </div>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
    </>
  );

  if (link) {
    return (
      <Modal open onClose={onClose} title="Log In to EarthRef" footer={footer}>
        <div className="space-y-4 py-2 text-center">
          <p className="text-sm text-gray-700">
            Continue to sign in with the link from your email.
          </p>
          {redeem.error && <ErrorMessage error={redeem.error} />}
          <Button onClick={() => redeem.mutate()} disabled={redeem.isPending}>
            {redeem.isPending ? "Please wait…" : "Continue Signing In"}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Log In or Sign Up" wide footer={footer}>
      {initialError && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {initialError}
        </p>
      )}
      <div
        className={
          providers.length
            ? "grid items-stretch gap-4 sm:grid-cols-[1fr_auto_1fr]"
            : "mx-auto max-w-sm"
        }
      >
        {providers.length > 0 && (
          <>
            <div className="flex flex-col justify-center gap-2 py-2">
              <p className="mb-1 text-sm font-medium text-gray-700">With an account you have:</p>
              {providers.map((p) => (
                <Button
                  key={p.id}
                  variant="secondary"
                  className="w-full"
                  disabled={provider.isPending}
                  onClick={() => provider.mutate(p.id)}
                >
                  Continue with {p.name}
                </Button>
              ))}
              {provider.error && <ErrorMessage error={provider.error} />}
            </div>
            <div className="flex items-center justify-center" aria-hidden="true">
              <div className="flex flex-row items-center gap-2 sm:flex-col">
                <span className="h-px w-10 bg-gray-300 sm:h-10 sm:w-px" />
                <span className="text-xs font-semibold text-gray-400">OR</span>
                <span className="h-px w-10 bg-gray-300 sm:h-10 sm:w-px" />
              </div>
            </div>
          </>
        )}
        <div className="py-2">
          {sentTo ? (
            <div className="space-y-3 text-sm text-gray-700" role="status">
              <p className="font-medium">Check your email.</p>
              <p>
                We sent a sign-in link to <strong>{sentTo}</strong>. It works once and expires soon;
                open it in this browser.
              </p>
              <button
                type="button"
                onClick={() => setSentTo(null)}
                className="text-node-ink hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm font-medium text-gray-700">With your email:</p>
              <div>
                <label
                  htmlFor="login-email"
                  className="mb-1 block text-sm font-medium text-gray-700"
                >
                  Email
                </label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              {send.error && <ErrorMessage error={send.error} />}
              <Button type="submit" className="w-full" disabled={send.isPending}>
                {send.isPending ? "Please wait…" : "Email Me a Sign-In Link"}
              </Button>
              <p className="text-xs text-gray-500">
                No password needed. New to EarthRef? The link creates your account.
              </p>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function LoginModalProvider({ children }: { children: ReactNode }) {
  // A sign-in that came back in the URL (an emailed link, a provider's error)
  // opens the modal straight away.
  const [shown, setShown] = useState(() => pendingSignIn);
  const [isOpen, setIsOpen] = useState(() => pendingSignIn !== null);
  const openLogin = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    clearPendingSignIn();
    setIsOpen(false);
    setShown(null);
  }, []);
  const value = useMemo(() => ({ openLogin }), [openLogin]);

  return (
    <LoginModalContext.Provider value={value}>
      {children}
      {isOpen && (
        <LoginModalDialog onClose={close} link={shown?.link} initialError={shown?.error} />
      )}
    </LoginModalContext.Provider>
  );
}
