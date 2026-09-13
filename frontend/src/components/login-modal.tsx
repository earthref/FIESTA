import { useMutation } from "@tanstack/react-query";
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
import type { TokenResponse, UserOut } from "../lib/types";
import { ErrorMessage } from "./error-message";
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

type Mode = "login" | "register";

function LoginModalDialog({ onClose }: { onClose: () => void }) {
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "register") {
        await api<UserOut>("/v2/auth/register", {
          method: "POST",
          json: { email, password, name },
        });
      }
      // OAuth2 password flow: form-encoded body with username/password fields.
      return api<TokenResponse>("/v2/auth/login", {
        method: "POST",
        form: { username: email, password },
      });
    },
    onSuccess: (data) => {
      login(data.access_token);
      onClose();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!mutation.isPending) mutation.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Log In to EarthRef"
      wide
      footer={
        <>
          <a
            href="mailto:webmaster@earthref.org"
            className="mr-auto inline-flex items-center rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Having Trouble? Email Us
          </a>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="grid items-stretch gap-4 sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex flex-col items-center justify-center gap-3 py-4 text-center">
          <p className="text-sm font-medium text-gray-700">With an ORCID iD:</p>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-not-allowed rounded-md bg-black px-4 py-2 text-sm font-medium text-white opacity-60"
          >
            Log In or Register with ORCID
          </button>
        </div>
        <div className="flex items-center justify-center" aria-hidden="true">
          <div className="flex flex-row items-center gap-2 sm:flex-col">
            <span className="h-px w-10 bg-gray-300 sm:h-10 sm:w-px" />
            <span className="text-xs font-semibold text-gray-400">OR</span>
            <span className="h-px w-10 bg-gray-300 sm:h-10 sm:w-px" />
          </div>
        </div>
        <div className="py-2">
          <p className="mb-3 text-sm font-medium text-gray-700">Without an ORCID iD:</p>
          <form onSubmit={onSubmit} className="space-y-3">
            {mode === "register" && (
              <div>
                <label
                  htmlFor="login-name"
                  className="mb-1 block text-sm font-medium text-gray-700"
                >
                  Name
                </label>
                <Input
                  id="login-name"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            )}
            <div>
              <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-gray-700">
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
            <div>
              <label
                htmlFor="login-password"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Password
              </label>
              <Input
                id="login-password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "register" ? 8 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {mutation.error && <ErrorMessage error={mutation.error} />}
            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending
                ? "Please wait…"
                : mode === "login"
                  ? "Log In to EarthRef"
                  : "Register with EarthRef"}
            </Button>
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
              className="text-sm text-node hover:underline"
            >
              {mode === "login"
                ? "No account yet? Register with your email"
                : "Already have an account? Log in"}
            </button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

export function LoginModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const openLogin = useCallback(() => setIsOpen(true), []);
  const value = useMemo(() => ({ openLogin }), [openLogin]);

  return (
    <LoginModalContext.Provider value={value}>
      {children}
      {isOpen && <LoginModalDialog onClose={() => setIsOpen(false)} />}
    </LoginModalContext.Provider>
  );
}
