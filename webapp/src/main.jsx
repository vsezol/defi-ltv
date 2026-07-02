import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "@telegram-apps/telegram-ui";
import "@telegram-apps/telegram-ui/dist/styles.css";
import "./index.css";
import App from "./App.jsx";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppRoot>
      <App />
    </AppRoot>
  </React.StrictMode>
);
