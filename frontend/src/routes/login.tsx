import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useLoginModal } from "../components/login-modal";
import { useAuth } from "../lib/auth";

/** /login opens the global EarthRef login modal over the home page. */
export function LoginPage() {
  const { openLogin } = useLoginModal();
  const { user } = useAuth();
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!user) openLogin();
    navigate({ to: "/", replace: true });
  }, [user, openLogin, navigate]);

  return null;
}
