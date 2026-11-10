import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, tabFromHash } from "./app";
import { dispatch } from "./lib/store";

dispatch({ type: "tab", data: tabFromHash(location.hash) });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
