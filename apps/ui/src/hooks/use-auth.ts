import { getAuthStatus } from "@/api/auth";
import { useAppStore } from "@/store/app";
import { isWeb } from "@/utils";
import { createElement, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function WebAuthGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const apiKey = useAppStore((state) => state.apiKey);

  useEffect(() => {
    if (!isWeb || location.pathname === "/signin" || apiKey) return;

    getAuthStatus()
      .then(() => {
        navigate("/signin");
      })
      .catch(() => {
        // The HTTP interceptor handles 401. Ignore startup connection errors.
      });
  }, [apiKey, location.pathname, navigate]);

  return null;
}

export function AuthGuard() {
  return isWeb ? createElement(WebAuthGuard) : null;
}
