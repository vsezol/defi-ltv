import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Caption, Placeholder, Spinner } from "@telegram-apps/telegram-ui";
import { api, setToken } from "./api.js";

const WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";

export default function Login() {
  const [botUsername, setBotUsername] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authing, setAuthing] = useState(false);
  const widgetRef = useRef(null);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const config = await api.getConfig();
      if (!config?.botUsername) throw new Error("Bot username missing in config");
      setBotUsername(config.botUsername);
    } catch (err) {
      setConfigError(err?.message || "Failed to load configuration");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // The Login Widget calls window.onTelegramAuth(user) after the user confirms.
  useEffect(() => {
    window.onTelegramAuth = async (user) => {
      setAuthing(true);
      setAuthError(null);
      try {
        const result = await api.loginWithWidget(user);
        if (!result?.token) throw new Error("No token in response");
        // setToken notifies App via onAuthChange → it re-renders into the main app.
        setToken(result.token);
      } catch (err) {
        setAuthError(err?.message || "Login failed");
      } finally {
        setAuthing(false);
      }
    };
    return () => {
      delete window.onTelegramAuth;
    };
  }, []);

  // Embed the official widget script once the bot username is known.
  useEffect(() => {
    const container = widgetRef.current;
    if (!container || !botUsername) return undefined;
    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    container.appendChild(script);
    return () => {
      container.innerHTML = "";
    };
  }, [botUsername]);

  return (
    <div className="login-screen">
      <Placeholder
        header="DeFi Monitor"
        description="Sign in with Telegram to manage your wallets, positions and alerts."
      >
        {configLoading && <Spinner size="l" />}

        {!configLoading && configError && (
          <div className="login-block">
            <Caption style={{ color: "var(--tgui--destructive_text_color)" }}>
              {configError}
            </Caption>
            <Button size="m" onClick={loadConfig}>
              Try again
            </Button>
          </div>
        )}

        {!configLoading && !configError && (
          <div className="login-block">
            <div ref={widgetRef} className="login-widget-container" data-testid="tg-widget" />
            {authing && <Spinner size="s" />}
            {authError && (
              <Caption style={{ color: "var(--tgui--destructive_text_color)" }}>
                {authError}
              </Caption>
            )}
            <Caption style={{ color: "var(--tgui--hint_color)", textAlign: "center" }}>
              Login via Telegram. If the button doesn't appear, this domain isn't linked to
              @{botUsername} (BotFather → /setdomain).
            </Caption>
          </div>
        )}
      </Placeholder>
    </div>
  );
}
