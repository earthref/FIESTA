import { useMutation } from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import { usePortalIdentity } from "../lib/portals";
import { capturePage, SCREENSHOT_EXCLUDE } from "../lib/screenshot";
import { ErrorMessage } from "./error-message";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

const WEBMASTER = "webmaster@earthref.org";

interface ContactContextValue {
  /** Screenshot the page as it is now and open the "Email Us" form. */
  openContact: () => void;
}

const ContactContext = createContext<ContactContextValue | null>(null);

export function useContact(): ContactContextValue {
  const context = useContext(ContactContext);
  if (!context) throw new Error("useContact must be used within ContactProvider");
  return context;
}

const label = "mb-1 block text-sm font-medium text-gray-700";

/** "Having trouble? Email Us": a message to the webmaster (POST /v2/contact)
 * with the screenshot taken when the form opened, which the sender can drop. */
function ContactDialog({
  screenshot,
  onClose,
}: {
  screenshot: Promise<string | null>;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { data: config } = useNodeConfig();
  const portal = usePortalIdentity();
  const repository = (!portal && config?.key) || "FIESTA";
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [attach, setAttach] = useState(true);

  useEffect(() => {
    let live = true;
    screenshot.then((taken) => live && setImage(taken));
    return () => {
      live = false;
    };
  }, [screenshot]);

  const send = useMutation({
    mutationFn: () =>
      api<{ sent: boolean }>("/v2/contact", {
        json: {
          name: name.trim(),
          email: email.trim(),
          subject: subject.trim(),
          message,
          page: window.location.href,
          repository,
          screenshot: attach && image ? image : null,
          website,
        },
      }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!send.isPending) send.mutate();
  };

  if (send.isSuccess) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Email Us"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="space-y-2 text-sm text-gray-700" role="status">
          <p className="font-medium">Thank you, your message has been sent.</p>
          <p>We will reply to {email.trim()} as soon as we can.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Email Us"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="contact-form" disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={onSubmit} className="space-y-3">
        <p className="text-sm text-gray-600">
          Having trouble with {repository} or your EarthRef account? Send us a message; we reply by
          email. You can also write to{" "}
          <a href={`mailto:${WEBMASTER}`} className="text-node-ink hover:underline">
            {WEBMASTER}
          </a>
          .
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="contact-name" className={label}>
              Name
            </label>
            <Input
              id="contact-name"
              autoComplete="name"
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="contact-email" className={label}>
              Email
            </label>
            <Input
              id="contact-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="contact-subject" className={label}>
            Subject
          </label>
          <Input
            id="contact-subject"
            maxLength={200}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="contact-message" className={label}>
            Message
          </label>
          <textarea
            id="contact-message"
            required
            maxLength={20000}
            rows={6}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className="w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-[13px] text-gray-900 placeholder:text-ink-faint focus:border-node focus:outline-hidden focus:ring-1 focus:ring-node"
            placeholder="What were you trying to do, and what happened?"
          />
        </div>
        {/* Honeypot: hidden from people, filled in by form-spamming bots. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={attach && image !== null}
              disabled={!image}
              onChange={(event) => setAttach(event.target.checked)}
            />
            Attach a screenshot of this page
          </label>
          <div className="mt-2">
            {image === undefined ? (
              <p className="text-xs text-gray-500">Taking the screenshot…</p>
            ) : image === null ? (
              <p className="text-xs text-gray-500">The screenshot could not be taken.</p>
            ) : (
              <img
                src={image}
                alt="Screenshot of the page"
                className={`max-h-48 rounded-sm border border-gray-200 ${attach ? "" : "opacity-40"}`}
              />
            )}
          </div>
        </div>
        {send.error && <ErrorMessage error={send.error} />}
      </form>
    </Modal>
  );
}

export function ContactProvider({ children }: { children: ReactNode }) {
  const [screenshot, setScreenshot] = useState<Promise<string | null> | null>(null);
  const isOpen = useRef(false);
  // The capture starts before the modal renders, and the modal is marked to
  // be left out of it, so the screenshot shows the page (and any dialog
  // already open, like the sign-in form) as it was when clicked.
  const openContact = useCallback(() => {
    if (isOpen.current) return;
    isOpen.current = true;
    setScreenshot(capturePage());
  }, []);
  const close = useCallback(() => {
    isOpen.current = false;
    setScreenshot(null);
  }, []);
  const value = useMemo(() => ({ openContact }), [openContact]);

  return (
    <ContactContext.Provider value={value}>
      {children}
      {screenshot && (
        <div {...{ [SCREENSHOT_EXCLUDE]: "" }}>
          <ContactDialog screenshot={screenshot} onClose={close} />
        </div>
      )}
    </ContactContext.Provider>
  );
}
