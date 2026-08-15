import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "@/router";
import { ToastProvider } from "@/components/ui/Toast";
import "./index.css";

// Apply the saved theme before React mounts so there is no flash.
const saved = localStorage.getItem("cr:theme") ?? "dark";
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle(
  "dark",
  saved === "dark" || (saved === "system" && prefersDark),
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </React.StrictMode>,
);
