import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "@/router";
import { ToastProvider } from "@/components/ui/Toast";
import "./index.css";

// The theme is resolved by the inline script in index.html, before first paint,
// so the boot splash is already the right colour when this bundle arrives.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </React.StrictMode>,
);

// Hand the screen over once the first frame of the app has actually painted.
// The splash fades rather than cuts, so the light doesn't vanish mid-orbit.
const boot = document.getElementById("boot");
if (boot) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      boot.dataset.leaving = "true";
      boot.addEventListener("transitionend", () => boot.remove(), { once: true });
      window.setTimeout(() => boot.remove(), 800);
    }),
  );
}
